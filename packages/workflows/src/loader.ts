import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { defineProfile, type Profile, type SandboxPolicy } from "@oma/core";
import { resolveComposition } from "./composition";
import { z } from "zod";
import {
  workflowAgentSchema,
  workflowContextSchema,
  workflowDataSchema,
  workflowEnvSchema,
  workflowInputSchema,
  workflowLoopSchema,
  workflowObjectSchema,
  workflowPolicySchema,
  workflowStageSchema,
  workflowTriggerSchema,
  type WorkflowAgent,
  type WorkflowData
} from "./schema";

export type WorkflowDiagnosticSeverity = "error" | "warning";

export interface WorkflowDiagnostic {
  severity: WorkflowDiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

/** An inline agent compiled to the core runtime Profile plus its routing. */
export interface CompiledAgent {
  profile: Profile;
  /** Model routing string: provider model name or module://pkg#export. */
  model?: string;
}

export interface CompiledAgents {
  /** The workflow-level default agent, when declared. */
  default?: CompiledAgent;
  /** Per-stage agents (complete replacements, never merged with the default). */
  stages: Record<string, CompiledAgent>;
}

export interface LoadedWorkflow {
  workflow?: WorkflowData;
  path: string;
  rootDir: string;
  /** sha256 hex of the raw source text; absent when the file could not be read. */
  sourceHash?: string;
  /** Inline agents compiled to core Profiles (instructions loaded, sandbox normalized). */
  agents?: CompiledAgents;
  /** Absolute path of the `run:` code module, when declared and present. */
  runModulePath?: string;
  diagnostics: WorkflowDiagnostic[];
}

export interface LoadWorkflowOptions {
  /** Compile inline agents (loads instruction files); default true. */
  compileAgents?: boolean;
}

const workflowExtensions = new Set([".yml", ".yaml", ".json"]);

export async function loadWorkflowDocument(
  inputPath: string,
  options: LoadWorkflowOptions = {}
): Promise<LoadedWorkflow> {
  const path = resolve(inputPath);
  const rootDir = dirname(path);
  const diagnostics: WorkflowDiagnostic[] = [];
  const result: LoadedWorkflow = { path, rootDir, diagnostics };

  if (!workflowExtensions.has(extname(path))) {
    diagnostics.push({
      severity: "error",
      code: "workflow.unsupported_format",
      message: `Workflow files must be .yml, .yaml, or .json: ${inputPath}`,
      path
    });
    return result;
  }

  let source: string;

  try {
    source = await Bun.file(path).text();
  } catch {
    diagnostics.push({
      severity: "error",
      code: "workflow.not_found",
      message: `Workflow file does not exist: ${inputPath}`,
      path
    });
    return result;
  }

  result.sourceHash = sha256(source);

  let raw: unknown;

  try {
    raw = extname(path) === ".json" ? JSON.parse(source) : Bun.YAML.parse(source);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: "workflow.parse_failed",
      message: error instanceof Error ? error.message : String(error),
      path
    });
    return result;
  }

  // extends/use resolve before validation: the merged document is what the
  // strict schema checks, while sourceHash stays the child file's text.
  const composed = await resolveComposition(raw, rootDir);
  diagnostics.push(...composed.diagnostics);

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return result;
  }

  const parsed = workflowDataSchema.safeParse(composed.resolved);

  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics(parsed.error));
    return result;
  }

  result.workflow = parsed.data;

  if (parsed.data.run) {
    const runPath = resolve(rootDir, parsed.data.run);

    if (await Bun.file(runPath).exists()) {
      result.runModulePath = runPath;
    } else {
      diagnostics.push({
        severity: "error",
        code: "workflow.run_module_missing",
        message: `Code workflow module not found: ${parsed.data.run}`,
        path: "run",
        hint: "The path is resolved relative to the workflow file."
      });
    }
  }

  if (options.compileAgents === false) {
    return result;
  }

  result.agents = { stages: {} };

  if (parsed.data.agent) {
    result.agents.default = await compileAgent(
      parsed.data.agent,
      parsed.data,
      parsed.data.name,
      "agent",
      rootDir,
      diagnostics
    );
  }

  for (const [stageName, stage] of Object.entries(parsed.data.stages ?? {})) {
    const agent = stage.agent;

    if (agent) {
      result.agents.stages[stageName] = await compileAgent(
        agent,
        parsed.data,
        `${parsed.data.name}/${stageName}`,
        `stages.${stageName}.agent`,
        rootDir,
        diagnostics
      );
    } else if (result.agents.default) {
      result.agents.stages[stageName] = result.agents.default;
    }
  }

  return result;
}

/**
 * Compiles an inline agent into the core runtime Profile: instruction files
 * loaded (workflow-dir-relative, then cwd), sandbox normalized, and the
 * workflow's policy applied — the profile is derived state, never an artifact.
 */
async function compileAgent(
  agent: WorkflowAgent,
  workflow: WorkflowData,
  name: string,
  diagnosticPath: string,
  rootDir: string,
  diagnostics: WorkflowDiagnostic[]
): Promise<CompiledAgent> {
  const instructionTexts: string[] = [];

  for (const [index, reference] of agent.instructions.entries()) {
    const text = await readFirstExisting([resolve(rootDir, reference), resolve(reference)]);

    if (text === undefined) {
      diagnostics.push({
        severity: "error",
        code: "workflow.instructions_missing",
        message: `Instructions file not found: ${reference}`,
        path: `${diagnosticPath}.instructions.${index}`,
        hint: "Paths resolve relative to the workflow file, then the working directory."
      });
      continue;
    }

    instructionTexts.push(text);
  }

  const sandboxPolicy: SandboxPolicy =
    typeof agent.sandbox === "string" ? { kind: agent.sandbox } : (agent.sandbox as SandboxPolicy);

  const profile = defineProfile({
    name,
    mode: "automation",
    systemPrompt: agent.prompt,
    skills: instructionTexts,
    tools: agent.tools,
    sandboxPolicy,
    modelDefaults: {},
    policy: {
      toolError: workflow.policy.onToolError ?? "continue",
      ...(workflow.policy.maxSteps !== undefined ? { maxSteps: workflow.policy.maxSteps } : {})
    }
  });

  return { profile, model: agent.model };
}

async function readFirstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      if (await Bun.file(candidate).exists()) {
        return await Bun.file(candidate).text();
      }
    } catch {
      // try next candidate
    }
  }

  return undefined;
}

export async function requireLoadedWorkflow(
  inputPath: string,
  options: LoadWorkflowOptions = {}
): Promise<LoadedWorkflow & { workflow: WorkflowData; sourceHash: string }> {
  const loaded = await loadWorkflowDocument(inputPath, options);
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

  if (!loaded.workflow || !loaded.sourceHash || errors.length > 0) {
    throw new Error(formatWorkflowDiagnostics(loaded.diagnostics));
  }

  return loaded as LoadedWorkflow & { workflow: WorkflowData; sourceHash: string };
}

export const defaultWorkflowDir = ".oma/workflows";

export async function listWorkflowFiles(dir = defaultWorkflowDir): Promise<string[]> {
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => workflowExtensions.has(extname(entry)))
    .sort()
    .map((entry) => join(dir, entry));
}

/**
 * Resolves a bare workflow name (`pr-review`) to a file in the workflow
 * directory, or returns undefined when no candidate exists.
 */
export async function resolveWorkflowName(
  name: string,
  dir = defaultWorkflowDir
): Promise<string | undefined> {
  for (const extension of [".yml", ".yaml", ".json"]) {
    const candidate = join(dir, `${name}${extension}`);

    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  return undefined;
}

export function isWorkflowPath(input: string): boolean {
  const extension = extname(input);
  return extension === ".yml" || extension === ".yaml";
}

export function formatWorkflowDiagnostics(diagnostics: WorkflowDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No workflow diagnostics.";
  }

  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.path ? ` ${diagnostic.path}` : "";
      const hint = diagnostic.hint ? `\n  hint: ${diagnostic.hint}` : "";
      return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location}: ${diagnostic.message}${hint}`;
    })
    .join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const knownFieldsByPath: Record<string, string[]> = {
  "": Object.keys(workflowObjectSchema.shape),
  trigger: Object.keys(workflowTriggerSchema.shape),
  agent: Object.keys(workflowAgentSchema.shape),
  policy: Object.keys(workflowPolicySchema.shape),
  inputs: Object.keys(workflowInputSchema.shape),
  stages: Object.keys(workflowStageSchema.shape),
  loop: Object.keys(workflowLoopSchema.shape),
  env: Object.keys(workflowEnvSchema.shape),
  context: Object.keys(workflowContextSchema.shape)
};

function zodDiagnostics(error: z.ZodError): WorkflowDiagnostic[] {
  return error.issues.flatMap((issue): WorkflowDiagnostic[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        severity: "error" as const,
        code: "workflow.unknown_field",
        message: `Unknown workflow field "${key}".`,
        path: [...issue.path, key].join("."),
        hint: unknownFieldHint(issue.path.map(String), key)
      }));
    }

    return [
      {
        severity: "error",
        code: "workflow.invalid",
        message: issue.message,
        path: issue.path.join(".") || undefined
      }
    ];
  });
}

function unknownFieldHint(path: string[], key: string): string {
  const known = knownFieldsForPath(path);
  const nearest = known ? nearestField(key, known) : undefined;
  return nearest
    ? `Did you mean "${nearest}"? Otherwise remove it from the workflow.`
    : "Remove it from the workflow.";
}

function knownFieldsForPath(path: string[]): string[] | undefined {
  if (path.length === 0) {
    return knownFieldsByPath[""];
  }

  if (path[0] === "inputs") {
    return knownFieldsByPath.inputs;
  }

  return knownFieldsByPath[path.join(".")] ?? knownFieldsByPath[path[0]!];
}

function nearestField(key: string, fields: string[]): string | undefined {
  let best: { field: string; distance: number } | undefined;

  for (const field of fields) {
    const distance = editDistance(key.toLowerCase(), field.toLowerCase());

    if (!best || distance < best.distance) {
      best = { field, distance };
    }
  }

  return best && best.distance <= Math.max(2, Math.floor(best.field.length / 3))
    ? best.field
    : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);

  for (let column = 0; column <= right.length; column += 1) {
    previous[column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + substitution
      );
    }

    for (let column = 0; column <= right.length; column += 1) {
      previous[column] = current[column]!;
    }
  }

  return previous[right.length]!;
}
