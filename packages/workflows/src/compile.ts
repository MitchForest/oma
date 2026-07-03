import type {
  NewSessionEvent,
  Profile,
  TriggerDefinition,
  TriggerSignal
} from "@oma/core";
import type { WorkflowData } from "./schema";
import { parseDuration, parseTokenCount } from "./units";

export const manualTriggerPattern = "manual:run";

export interface CompileWorkflowOptions {
  /** The live profile the workflow's agent binds to. */
  profile: Profile;
  sourceHash: string;
  sourcePath?: string;
  /**
   * Session key override. Defaults to `trigger.session` falling back to the
   * profile's own sessionKey. Pass `null` to force a caller-chosen session id
   * (via `fallbackSessionId`), e.g. for ad-hoc manual runs.
   */
  sessionKey?: string | null;
}

export interface CompiledWorkflow {
  workflow: WorkflowData;
  sourceHash: string;
  sourcePath?: string;
  /** Profile with the workflow's session key and effects policy applied. */
  profile: Profile;
  /** One definition per trigger pattern, plus the always-present manual one. */
  triggers: TriggerDefinition[];
  maxSteps?: number;
  /** Parsed hard budgets ("2M" -> tokens, "30m" -> wallMs). */
  budget?: { tokens?: number; wallMs?: number };
  spawnEvents: NewSessionEvent[];
  signalEvents(signal: TriggerSignal): NewSessionEvent[];
}

export function compileWorkflow(
  workflow: WorkflowData,
  options: CompileWorkflowOptions
): CompiledWorkflow {
  const sessionKey =
    options.sessionKey === null
      ? undefined
      : (options.sessionKey ?? workflow.trigger?.session ?? options.profile.sessionKey);
  // The workflow's effects extend the profile's, workflow rules winning per
  // pattern: the file a reviewer reads is the file that binds.
  const effects = workflow.policy.effects
    ? { ...options.profile.policy.effects, ...workflow.policy.effects }
    : options.profile.policy.effects;
  const profile: Profile = {
    ...options.profile,
    sessionKey,
    policy: {
      ...options.profile.policy,
      ...(effects ? { effects } : {})
    }
  };
  // Staged workflows never route through these definitions (each stage has
  // its own prompt); the fallback only exists to keep the type total.
  const promptTemplate = workflow.prompt ?? `Run workflow ${workflow.name}.`;
  const prompt = (signal: TriggerSignal) =>
    interpolateTemplate(promptTemplate, signalContext(signal));
  const filter = workflow.trigger?.filter
    ? (signal: TriggerSignal) => matchesWorkflowFilter(workflow.trigger!.filter!, signal)
    : undefined;
  const patterns = workflow.trigger ? [workflow.trigger.on, ...workflow.trigger.also] : [];
  const triggers: TriggerDefinition[] = [
    ...patterns.map((on) => ({ on, profile, filter, prompt })),
    // Manual runs bypass the trigger filter: the filter describes signal
    // payloads, not operator intent.
    { on: manualTriggerPattern, profile, prompt }
  ];

  return {
    workflow,
    sourceHash: options.sourceHash,
    sourcePath: options.sourcePath,
    profile,
    triggers,
    maxSteps: workflow.policy.maxSteps ?? options.profile.policy.maxSteps,
    budget: workflow.policy.budget
      ? {
          tokens:
            workflow.policy.budget.tokens !== undefined
              ? parseTokenCount(workflow.policy.budget.tokens)
              : undefined,
          wallMs:
            workflow.policy.budget.wall !== undefined
              ? parseDuration(workflow.policy.budget.wall)
              : undefined
        }
      : undefined,
    spawnEvents: [
      {
        type: "workflow.loaded",
        name: workflow.name,
        title: workflow.title,
        sourcePath: options.sourcePath,
        sourceHash: options.sourceHash
      }
    ],
    signalEvents: (signal) => [
      {
        type: "workflow.run.started",
        name: workflow.name,
        sourceHash: options.sourceHash,
        trigger: { source: signal.source, kind: signal.kind },
        inputs:
          signal.source === "manual" && isRecord(signal.payload)
            ? (signal.payload as Record<string, unknown>)
            : undefined
      }
    ]
  };
}

export interface ResolvedWorkflowInputs {
  inputs: Record<string, string>;
  errors: string[];
}

/**
 * Applies declared defaults and checks required inputs for a manual run.
 * Unknown inputs are errors: a misspelled `--input` must not silently vanish
 * from the prompt.
 */
export function resolveWorkflowInputs(
  workflow: WorkflowData,
  provided: Record<string, string>
): ResolvedWorkflowInputs {
  const inputs: Record<string, string> = {};
  const errors: string[] = [];

  for (const [name, value] of Object.entries(provided)) {
    if (!(name in workflow.inputs)) {
      errors.push(`Unknown input "${name}". Declare it under inputs in the workflow.`);
      continue;
    }

    inputs[name] = value;
  }

  for (const [name, declaration] of Object.entries(workflow.inputs)) {
    if (inputs[name] !== undefined) {
      continue;
    }

    if (declaration.default !== undefined) {
      inputs[name] = declaration.default;
      continue;
    }

    if (declaration.required) {
      errors.push(`Missing required input "${name}". Pass --input ${name}=<value>.`);
    }
  }

  return { inputs, errors };
}

export function manualTriggerSignal(
  workflow: WorkflowData,
  inputs: Record<string, string>
): TriggerSignal {
  return {
    source: "manual",
    kind: "run",
    payload: inputs,
    receivedAt: new Date().toISOString(),
    metadata: { workflow: workflow.name }
  };
}

/**
 * Replaces `{path}` placeholders against the signal context. Paths resolve
 * over `{source, kind, payload, metadata, inputs}`; an unresolvable path
 * throws with the field named — a prompt with a hole is worse than an error.
 */
export function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, rawPath: string) => {
    const value = readPath(context, rawPath.trim());

    if (value === undefined || value === null) {
      throw new Error(`Unable to resolve workflow template field: ${rawPath.trim()}`);
    }

    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

export function signalContext(signal: TriggerSignal): Record<string, unknown> {
  return {
    source: signal.source,
    kind: signal.kind,
    payload: signal.payload,
    metadata: signal.metadata,
    // Manual runs carry inputs as the payload; expose them under both names
    // so prompts can say `{inputs.issue}` and stay readable.
    inputs: signal.source === "manual" && isRecord(signal.payload) ? signal.payload : {}
  };
}

/**
 * Trigger matching for staged workflows, which route through the stage
 * runner instead of TriggerDefinitions: manual runs always match; signals
 * must match a declared pattern and pass the filter.
 */
export function matchesWorkflowSignal(workflow: WorkflowData, signal: TriggerSignal): boolean {
  if (signal.source === "manual" && signal.kind === "run") {
    return true;
  }

  if (!workflow.trigger) {
    return false;
  }

  const patterns = [workflow.trigger.on, ...workflow.trigger.also];
  const matched = patterns.some((pattern) => matchesTriggerPattern(pattern, signal));

  if (!matched) {
    return false;
  }

  return workflow.trigger.filter ? matchesWorkflowFilter(workflow.trigger.filter, signal) : true;
}

function matchesTriggerPattern(pattern: string, signal: TriggerSignal): boolean {
  const separator = pattern.indexOf(":");
  const source = pattern.slice(0, separator);
  const kind = pattern.slice(separator + 1);

  if (source !== signal.source) {
    return false;
  }

  if (kind === "*" || kind === signal.kind) {
    return true;
  }

  return kind.endsWith(".*") && signal.kind.startsWith(kind.slice(0, -1));
}

export function matchesWorkflowFilter(
  filter: Record<string, string | number | boolean>,
  signal: TriggerSignal
): boolean {
  const context = signalContext(signal);

  return Object.entries(filter).every(([path, expected]) => readPath(context, path) === expected);
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
