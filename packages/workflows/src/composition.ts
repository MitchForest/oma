import { extname, dirname, resolve } from "node:path";
import type { WorkflowDiagnostic } from "./loader";

/**
 * Workflow composition, resolved before validation so the merged document is
 * what the strict schema checks and the child file's hash is what the log
 * records.
 *
 * `extends: <path>` — inherit a base workflow. Merge rules are explicit:
 * scalars and arrays are replaced by the child; the object maps `stages`,
 * `inputs`, `policy` (with `effects` merged per pattern), `env` (with
 * `secrets` merged per name), `trigger`, and `context` merge per key with
 * the child winning; stage entries merge field-by-field.
 *
 * `use: "<path>#<stage>"` on a stage — pull shared fields from a stage
 * library file (a YAML map of stage definitions); locally declared fields
 * override the library's.
 */

const maxExtendsDepth = 5;

export interface CompositionResult {
  resolved: unknown;
  diagnostics: WorkflowDiagnostic[];
}

export async function resolveComposition(
  raw: unknown,
  rootDir: string,
  seen: string[] = []
): Promise<CompositionResult> {
  const diagnostics: WorkflowDiagnostic[] = [];

  if (!isRecord(raw)) {
    return { resolved: raw, diagnostics };
  }

  let document: Record<string, unknown> = { ...raw };

  if (typeof document.extends === "string") {
    if (seen.length >= maxExtendsDepth) {
      diagnostics.push({
        severity: "error",
        code: "workflow.extends_too_deep",
        message: `extends chains are capped at ${maxExtendsDepth} levels.`,
        path: "extends"
      });
      return { resolved: document, diagnostics };
    }

    const basePath = await resolveReference(document.extends, rootDir);

    if (!basePath) {
      diagnostics.push({
        severity: "error",
        code: "workflow.extends_missing",
        message: `Base workflow not found: ${document.extends}`,
        path: "extends",
        hint: "The path is resolved relative to the workflow file, then the working directory."
      });
      return { resolved: document, diagnostics };
    }

    if (seen.includes(basePath)) {
      diagnostics.push({
        severity: "error",
        code: "workflow.extends_cycle",
        message: `extends cycle detected at ${document.extends}`,
        path: "extends"
      });
      return { resolved: document, diagnostics };
    }

    const baseRaw = await parseDocument(basePath);

    if (baseRaw === undefined) {
      diagnostics.push({
        severity: "error",
        code: "workflow.extends_unreadable",
        message: `Base workflow is not valid YAML/JSON: ${document.extends}`,
        path: "extends"
      });
      return { resolved: document, diagnostics };
    }

    const base = await resolveComposition(baseRaw, dirname(basePath), [...seen, basePath]);
    diagnostics.push(...base.diagnostics);

    if (isRecord(base.resolved)) {
      const { extends: _extends, ...child } = document;
      document = mergeWorkflow(base.resolved, child);
    }
  }

  if (isRecord(document.stages)) {
    const stages: Record<string, unknown> = {};

    for (const [name, stage] of Object.entries(document.stages)) {
      stages[name] = isRecord(stage)
        ? await resolveStageUse(stage, name, rootDir, diagnostics)
        : stage;
    }

    document = { ...document, stages };
  }

  return { resolved: document, diagnostics };
}

async function resolveStageUse(
  stage: Record<string, unknown>,
  stageName: string,
  rootDir: string,
  diagnostics: WorkflowDiagnostic[]
): Promise<Record<string, unknown>> {
  if (typeof stage.use !== "string") {
    return stage;
  }

  const [reference, entryName] = stage.use.split("#", 2);

  if (!reference || !entryName) {
    diagnostics.push({
      severity: "error",
      code: "workflow.use_invalid",
      message: `use must look like "path/to/stages.yml#stageName", got: ${stage.use}`,
      path: `stages.${stageName}.use`
    });
    return stage;
  }

  const libraryPath = await resolveReference(reference, rootDir);

  if (!libraryPath) {
    diagnostics.push({
      severity: "error",
      code: "workflow.use_missing",
      message: `Stage library not found: ${reference}`,
      path: `stages.${stageName}.use`
    });
    return stage;
  }

  const library = await parseDocument(libraryPath);
  const entry = isRecord(library) ? library[entryName] : undefined;

  if (!isRecord(entry)) {
    diagnostics.push({
      severity: "error",
      code: "workflow.use_missing",
      message: `Stage library ${reference} has no entry "${entryName}".`,
      path: `stages.${stageName}.use`
    });
    return stage;
  }

  const { use: _use, ...local } = stage;
  return { ...entry, ...local };
}

/** Child wins; the maps a reviewer thinks of as "extendable" merge per key. */
export function mergeWorkflow(
  base: Record<string, unknown>,
  child: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...child };

  for (const key of ["trigger", "context", "inputs"] as const) {
    merged[key] = mergeRecords(base[key], child[key]);
  }

  if (isRecord(base.stages) || isRecord(child.stages)) {
    const stages: Record<string, unknown> = { ...(isRecord(base.stages) ? base.stages : {}) };

    for (const [name, stage] of Object.entries(isRecord(child.stages) ? child.stages : {})) {
      stages[name] = mergeRecords(stages[name], stage) ?? stage;
    }

    merged.stages = stages;
  }

  if (isRecord(base.policy) || isRecord(child.policy)) {
    const basePolicy = isRecord(base.policy) ? base.policy : {};
    const childPolicy = isRecord(child.policy) ? child.policy : {};

    merged.policy = {
      ...basePolicy,
      ...childPolicy,
      ...(isRecord(basePolicy.effects) || isRecord(childPolicy.effects)
        ? { effects: mergeRecords(basePolicy.effects, childPolicy.effects) }
        : {}),
      ...(isRecord(basePolicy.budget) || isRecord(childPolicy.budget)
        ? { budget: mergeRecords(basePolicy.budget, childPolicy.budget) }
        : {})
    };
  }

  if (isRecord(base.env) || isRecord(child.env)) {
    const baseEnv = isRecord(base.env) ? base.env : {};
    const childEnv = isRecord(child.env) ? child.env : {};

    merged.env = {
      ...baseEnv,
      ...childEnv,
      ...(isRecord(baseEnv.secrets) || isRecord(childEnv.secrets)
        ? { secrets: mergeRecords(baseEnv.secrets, childEnv.secrets) }
        : {})
    };
  }

  return merged;
}

function mergeRecords(base: unknown, child: unknown): unknown {
  if (!isRecord(base)) {
    return child ?? base;
  }

  if (!isRecord(child)) {
    return child === undefined ? base : child;
  }

  return { ...base, ...child };
}

async function resolveReference(reference: string, rootDir: string): Promise<string | undefined> {
  for (const candidate of [resolve(rootDir, reference), resolve(reference)]) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }

  return undefined;
}

async function parseDocument(path: string): Promise<unknown> {
  try {
    const text = await Bun.file(path).text();
    return extname(path) === ".json" ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
