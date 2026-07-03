import {
  send,
  spawn,
  sumRecordedUsage,
  wake,
  type HarnessRuntime,
  type Profile,
  type SessionEvent,
  type SessionStore
} from "@oma/core";
import { evaluateUntilCondition, parseUntilCondition } from "./conditions";
import { interpolateTemplate } from "./compile";
import { buildContextPack, contextPackEvent, renderContextSection } from "./context";
import { extractStageOutput, outputInstruction } from "./outputs";
import type { WorkflowData, WorkflowStage } from "./schema";

export interface StageRuntime {
  runtime: HarnessRuntime;
  profile: Profile;
  /** Recorded in stage session metadata so plain wake/approve work on it. */
  profilePath?: string;
}

export type StageRuntimeFactory = (stage: {
  name: string;
  definition: WorkflowStage;
  sessionId: string;
}) => Promise<StageRuntime>;

export interface StageRunnerDeps {
  store: SessionStore;
  factory: StageRuntimeFactory;
  /** Per-stage wake bound; defaults to the stage profile's policy.maxSteps. */
  maxSteps?: number;
  /** Workflow-wide hard budgets: tokens span every stage session; wall anchors at the last workflow.run.started. */
  budget?: { tokens?: number; wallMs?: number };
  /**
   * This runner's placement identity: "local" (default) or "worker:<name>".
   * Stages whose runs_on names a different placement are dispatched — the
   * runner pauses and the matching worker resumes the same log.
   */
  placement?: string;
}

export interface StageRunResult {
  status: "completed" | "paused" | "failed" | "denied" | "max-iterations";
  reason?: string;
  awaiting?: { stage: string; iteration: number };
}

interface StageRecord {
  stage: string;
  iteration: number;
  sessionId: string;
  status: "completed" | "failed";
  output?: Record<string, unknown>;
  reason?: string;
}

interface WorkflowProgress {
  payload: unknown;
  inputs: Record<string, unknown>;
  started: Set<string>;
  completed: Map<string, StageRecord>;
  requested: Set<string>;
  granted: Set<string>;
  denied: Map<string, string | undefined>;
  /** createdAt of the last workflow.run.started — the wall-budget anchor. */
  runStartedAt?: string;
  /** Stage#iteration keys already announced as dispatched to another placement. */
  dispatched: Set<string>;
  finished?: { status: StageRunResult["status"]; reason?: string };
}

/** A stage run that must stop the workflow resumably (budget or tool approval). */
interface StagePause {
  pause: true;
  reason: string;
}

function isStagePause(value: StageRecord | StagePause): value is StagePause {
  return "pause" in value;
}

/**
 * Deterministic loop engine over the parent session log. Everything the
 * runner needs — payload, inputs, completed stages, approvals — is derived
 * from events, so a crashed run resumes exactly where it stopped and a
 * completed stage is never executed twice (the same invariant recorded tool
 * results have).
 */
export async function runWorkflowStages(
  deps: StageRunnerDeps,
  workflow: WorkflowData,
  meta: { parentSessionId: string; sourceHash: string; codeModulePath?: string }
): Promise<StageRunResult> {
  const stages = workflow.stages;

  if (!stages) {
    throw new Error(`Workflow ${workflow.name} has no stages.`);
  }

  const parent = await deps.store.getSession(meta.parentSessionId);
  const progress = deriveProgress(parent.events);

  if (progress.finished) {
    return progress.finished;
  }

  if (workflow.run) {
    if (!meta.codeModulePath) {
      throw new Error(`Workflow ${workflow.name} declares run: ${workflow.run} but no module path was resolved.`);
    }

    return runWorkflowCode(deps, workflow, meta, progress, meta.codeModulePath);
  }

  const order = Object.keys(stages);
  const loop = workflow.loop;
  const condition = loop ? parseUntilCondition(loop.until) : undefined;
  let iteration = deriveIteration(progress, loop?.over ?? []);
  let position = 0;

  while (position < order.length) {
    const name = order[position]!;
    const definition = stages[name]!;
    const inLoop = loop?.over.includes(name) ?? false;
    const stageIteration = inLoop ? iteration : 1;
    const key = stageKey(name, stageIteration);
    let record = progress.completed.get(key);

    if (!record) {
      const dispatch = await deferToPlacement(deps, meta, progress, {
        name,
        definition,
        iteration: stageIteration
      });

      if (dispatch) {
        return dispatch;
      }

      const outcome = await runStage(deps, workflow, meta, progress, {
        name,
        definition,
        iteration: stageIteration
      });

      if (isStagePause(outcome)) {
        return {
          status: "paused",
          awaiting: { stage: name, iteration: stageIteration },
          reason: outcome.reason
        };
      }

      record = outcome;
      progress.completed.set(key, record);
    }

    if (record.status === "failed") {
      return finishRun(deps.store, meta, workflow, {
        status: "failed",
        reason: record.reason ?? `Stage ${name} failed.`
      });
    }

    if (definition.approve) {
      const denialReason = progress.denied.get(key);

      if (progress.denied.has(key)) {
        return finishRun(deps.store, meta, workflow, {
          status: "denied",
          reason: denialReason ?? `Stage ${name} was denied.`
        });
      }

      if (!progress.granted.has(key)) {
        if (!progress.requested.has(key)) {
          await deps.store.appendEvent(meta.parentSessionId, {
            type: "human.approval.requested",
            stage: name,
            iteration: stageIteration,
            summary: record.output ? JSON.stringify(record.output) : undefined
          });
          progress.requested.add(key);
        }

        return { status: "paused", awaiting: { stage: name, iteration: stageIteration } };
      }
    }

    const lastInLoop = inLoop && loop && name === loop.over[loop.over.length - 1];

    if (lastInLoop && loop && condition) {
      const untilKey = stageKey(condition.stage, iteration);
      const untilOutput = progress.completed.get(untilKey)?.output;

      if (evaluateUntilCondition(condition, untilOutput)) {
        position += 1;
        continue;
      }

      if (iteration >= loop.max) {
        return finishRun(deps.store, meta, workflow, {
          status: "max-iterations",
          reason: `Loop did not satisfy "${loop.until}" within ${loop.max} iterations.`
        });
      }

      iteration += 1;
      position = order.indexOf(loop.over[0]!);
      continue;
    }

    position += 1;
  }

  return finishRun(deps.store, meta, workflow, { status: "completed" });
}

/**
 * Orchestration is itinerant: any process can resume the parent log, so
 * "dispatching" a stage to another placement just means pausing here. The
 * dispatched event is recorded once so observers (tail/show) see what the
 * workflow is waiting for.
 */
async function deferToPlacement(
  deps: StageRunnerDeps,
  meta: { parentSessionId: string },
  progress: WorkflowProgress,
  step: { name: string; definition: WorkflowStage; iteration: number }
): Promise<StageRunResult | undefined> {
  const target = step.definition.runs_on;
  const placement = deps.placement ?? "local";

  if (!target || target === placement) {
    return undefined;
  }

  const key = stageKey(step.name, step.iteration);

  if (!progress.dispatched.has(key)) {
    await deps.store.appendEvent(meta.parentSessionId, {
      type: "workflow.stage.dispatched",
      stage: step.name,
      iteration: step.iteration,
      runsOn: target
    });
    progress.dispatched.add(key);
  }

  return {
    status: "paused",
    awaiting: { stage: step.name, iteration: step.iteration },
    reason:
      target === "local"
        ? `Stage "${step.name}" runs locally — resume with: oma wake ${meta.parentSessionId}`
        : `Stage "${step.name}" is dispatched to ${target} — run: oma worker --name ${target.slice("worker:".length)}`
  };
}

/** Thrown by `stage()` when a gated stage awaits a human decision or a budget. */
class WorkflowPausedSignal extends Error {
  constructor(
    readonly awaiting: { stage: string; iteration: number },
    readonly reason?: string
  ) {
    super(reason ?? `Awaiting approval: ${awaiting.stage}#${awaiting.iteration}`);
  }
}

class WorkflowDeniedSignal extends Error {
  constructor(readonly reason?: string) {
    super(reason ?? "Denied.");
  }
}

export interface WorkflowCodeContext {
  /**
   * Runs a declared stage and returns its structured output. The nth call
   * for a stage name is iteration n; completed iterations replay from the
   * log without re-executing — which is what makes re-running the module
   * after a pause or crash safe, provided the module is deterministic
   * (same stage() call sequence for the same inputs).
   */
  stage(name: string): Promise<Record<string, unknown> | undefined>;
  inputs: Record<string, unknown>;
  payload: unknown;
}

/**
 * The escape hatch: a module default-exporting `async (ctx) => void` owns the
 * coordination while stages stay declared, durable, and replayable.
 */
async function runWorkflowCode(
  deps: StageRunnerDeps,
  workflow: WorkflowData,
  meta: { parentSessionId: string; sourceHash: string },
  progress: WorkflowProgress,
  modulePath: string
): Promise<StageRunResult> {
  const counters = new Map<string, number>();

  const stage = async (name: string): Promise<Record<string, unknown> | undefined> => {
    const definition = workflow.stages?.[name];

    if (!definition) {
      throw new Error(`stage("${name}") is not declared under stages in workflow ${workflow.name}`);
    }

    const iteration = (counters.get(name) ?? 0) + 1;
    counters.set(name, iteration);
    const key = stageKey(name, iteration);
    let record = progress.completed.get(key);

    if (!record) {
      const dispatch = await deferToPlacement(deps, meta, progress, { name, definition, iteration });

      if (dispatch) {
        throw new WorkflowPausedSignal({ stage: name, iteration }, dispatch.reason);
      }

      const outcome = await runStage(deps, workflow, meta, progress, { name, definition, iteration });

      if (isStagePause(outcome)) {
        throw new WorkflowPausedSignal({ stage: name, iteration }, outcome.reason);
      }

      record = outcome;
      progress.completed.set(key, record);
    }

    if (record.status === "failed") {
      throw new Error(record.reason ?? `Stage ${name} failed.`);
    }

    if (definition.approve) {
      if (progress.denied.has(key)) {
        throw new WorkflowDeniedSignal(progress.denied.get(key));
      }

      if (!progress.granted.has(key)) {
        if (!progress.requested.has(key)) {
          await deps.store.appendEvent(meta.parentSessionId, {
            type: "human.approval.requested",
            stage: name,
            iteration,
            summary: record.output ? JSON.stringify(record.output) : undefined
          });
          progress.requested.add(key);
        }

        throw new WorkflowPausedSignal({ stage: name, iteration });
      }
    }

    return record.output;
  };

  try {
    const module = (await import(modulePath)) as { default?: unknown };

    if (typeof module.default !== "function") {
      throw new Error(`Code workflow module must default-export a function: ${modulePath}`);
    }

    await module.default({
      stage,
      inputs: progress.inputs,
      payload: progress.payload
    } satisfies WorkflowCodeContext);

    return finishRun(deps.store, meta, workflow, { status: "completed" });
  } catch (error) {
    if (error instanceof WorkflowPausedSignal) {
      return { status: "paused", awaiting: error.awaiting, reason: error.reason };
    }

    if (error instanceof WorkflowDeniedSignal) {
      return finishRun(deps.store, meta, workflow, {
        status: "denied",
        reason: error.reason
      });
    }

    return finishRun(deps.store, meta, workflow, {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runStage(
  deps: StageRunnerDeps,
  workflow: WorkflowData,
  meta: { parentSessionId: string; sourceHash: string },
  progress: WorkflowProgress,
  step: { name: string; definition: WorkflowStage; iteration: number }
): Promise<StageRecord | StagePause> {
  const { name, definition, iteration } = step;
  const key = stageKey(name, iteration);
  const stageSessionId = `${meta.parentSessionId}/${name}`;
  const startedBefore = progress.started.has(key);

  if (!startedBefore) {
    await deps.store.appendEvent(meta.parentSessionId, {
      type: "workflow.stage.started",
      stage: name,
      iteration,
      sessionId: stageSessionId
    });
    progress.started.add(key);
  }

  const { runtime, profile, profilePath } = await deps.factory({
    name,
    definition,
    sessionId: stageSessionId
  });

  if (!(await deps.store.exists(stageSessionId))) {
    await spawn(deps.store, profile, {
      id: stageSessionId,
      metadata: {
        parentSessionId: meta.parentSessionId,
        workflowName: workflow.name,
        stage: name,
        ...(profilePath ? { profilePath } : {})
      }
    });
  }

  // Workflow-wide budgets: the token ceiling passed to this wake is the
  // remainder after what every *other* stage session already spent (the wake
  // counts this session's own usage itself); the wall deadline anchors at the
  // last workflow.run.started so resumes keep the original deadline.
  let tokenBudget: number | undefined;

  if (deps.budget?.tokens !== undefined) {
    const usedElsewhere = await usedTokensExcept(
      deps.store,
      workflow,
      meta.parentSessionId,
      stageSessionId
    );
    tokenBudget = Math.max(0, deps.budget.tokens - usedElsewhere);
  }

  const deadlineAt =
    deps.budget?.wallMs !== undefined && progress.runStartedAt
      ? Date.parse(progress.runStartedAt) + deps.budget.wallMs
      : undefined;

  const template =
    iteration === 1 ? definition.prompt : (definition.reprompt ?? definition.prompt);
  let rendered = renderStagePrompt(template, definition, progress, iteration);
  const recovery = startedBefore
    ? await inspectRecovery(deps.store, stageSessionId)
    : { sendPrompt: true, wakeSession: true };
  const contextBlock = definition.context ?? workflow.context;

  if (contextBlock && recovery.sendPrompt) {
    // Fresh pack per prompt render: loop iterations see current file state,
    // and the stage session records exactly what this message contained.
    const pack = await buildContextPack(contextBlock);
    await deps.store.appendEvent(stageSessionId, contextPackEvent(pack));
    rendered = `${renderContextSection(pack)}\n\n${rendered}`;
  }
  const maxSteps = deps.maxSteps ?? workflow.policy.maxSteps ?? profile.policy.maxSteps;
  let message: string | undefined = recovery.sendPrompt ? rendered : undefined;
  let mustWake = recovery.wakeSession;

  // Two attempts: the run itself, then one corrective retry when the stage
  // declares an output and the model's reply did not include a valid block.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (message !== undefined) {
      await send(deps.store, stageSessionId, message);
    }

    if (mustWake) {
      const result = await wake(runtime, stageSessionId, profile, {
        maxSteps,
        tokenBudget,
        deadlineAt
      });

      if (result.status === "waiting" && result.waitingOn?.type === "approval") {
        return {
          pause: true,
          reason: `Tool "${result.waitingOn.toolName}" awaits approval in session ${stageSessionId} — decide with: oma approve ${stageSessionId} | oma deny ${stageSessionId}`
        };
      }

      if (result.status === "paused" && result.pauseReason?.startsWith("budget:")) {
        return {
          pause: true,
          reason: `Stage "${name}" hit ${result.pauseReason}; raise policy.budget and wake to resume.`
        };
      }

      if (result.status !== "completed") {
        return recordStage(deps.store, meta.parentSessionId, {
          stage: name,
          iteration,
          sessionId: stageSessionId,
          status: "failed",
          reason: `Stage session ${result.status}${result.status === "paused" ? " (step budget exhausted)" : ""}.`
        });
      }
    }

    const assistant = await lastAssistantMessage(deps.store, stageSessionId);

    if (!definition.output) {
      return recordStage(deps.store, meta.parentSessionId, {
        stage: name,
        iteration,
        sessionId: stageSessionId,
        status: "completed"
      });
    }

    const extracted = extractStageOutput(assistant ?? "", definition.output);

    if (extracted.output) {
      return recordStage(deps.store, meta.parentSessionId, {
        stage: name,
        iteration,
        sessionId: stageSessionId,
        status: "completed",
        output: extracted.output
      });
    }

    message = `Your last message did not include the required output. ${extracted.error} Reply with only the fenced json block.`;
    mustWake = true;
  }

  return recordStage(deps.store, meta.parentSessionId, {
    stage: name,
    iteration,
    sessionId: stageSessionId,
    status: "failed",
    reason: "Stage did not produce a valid output block after a corrective retry."
  });
}

/**
 * Crash recovery for a stage that was started but never recorded complete:
 * if the stage session already answered its last message, skip straight to
 * extraction; if a user message is still pending, wake without re-sending.
 */
async function inspectRecovery(
  store: SessionStore,
  stageSessionId: string
): Promise<{ sendPrompt: boolean; wakeSession: boolean }> {
  if (!(await store.exists(stageSessionId))) {
    return { sendPrompt: true, wakeSession: true };
  }

  const session = await store.getSession(stageSessionId);
  let lastUser = -1;
  let lastAssistant = -1;

  for (const event of session.events) {
    if (event.type === "message.user") {
      lastUser = event.offset;
    } else if (event.type === "message.assistant") {
      lastAssistant = event.offset;
    }
  }

  if (lastUser === -1) {
    return { sendPrompt: true, wakeSession: true };
  }

  if (lastAssistant > lastUser) {
    return { sendPrompt: false, wakeSession: false };
  }

  return { sendPrompt: false, wakeSession: true };
}

function renderStagePrompt(
  template: string,
  definition: WorkflowStage,
  progress: WorkflowProgress,
  iteration: number
): string {
  const stages: Record<string, Record<string, unknown>> = {};

  for (const record of progress.completed.values()) {
    if (record.output) {
      // Later iterations overwrite earlier ones as the map is keyed by
      // insertion order of completion events — latest output wins.
      stages[record.stage] = record.output;
    }
  }

  const rendered = interpolateTemplate(template, {
    payload: progress.payload,
    inputs: progress.inputs,
    stages,
    iteration
  });

  return definition.output ? `${rendered}\n\n${outputInstruction(definition.output)}` : rendered;
}

async function recordStage(
  store: SessionStore,
  parentSessionId: string,
  record: StageRecord
): Promise<StageRecord> {
  await store.appendEvent(parentSessionId, {
    type: "workflow.stage.completed",
    stage: record.stage,
    iteration: record.iteration,
    sessionId: record.sessionId,
    status: record.status,
    output: record.output,
    reason: record.reason
  });

  return record;
}

async function finishRun(
  store: SessionStore,
  meta: { parentSessionId: string; sourceHash: string },
  workflow: WorkflowData,
  result: StageRunResult
): Promise<StageRunResult> {
  await store.appendEvent(meta.parentSessionId, {
    type: "workflow.run.completed",
    name: workflow.name,
    sourceHash: meta.sourceHash,
    status: result.status === "paused" ? "failed" : result.status,
    reason: result.reason
  });

  return result;
}

async function lastAssistantMessage(
  store: SessionStore,
  sessionId: string
): Promise<string | undefined> {
  const session = await store.getSession(sessionId);

  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]!;

    if (event.type === "message.assistant") {
      return event.content;
    }
  }

  return undefined;
}

export function stageKey(stage: string, iteration: number): string {
  return `${stage}#${iteration}`;
}

export function deriveProgress(events: SessionEvent[]): WorkflowProgress {
  const progress: WorkflowProgress = {
    payload: undefined,
    inputs: {},
    started: new Set(),
    completed: new Map(),
    requested: new Set(),
    granted: new Set(),
    denied: new Map(),
    dispatched: new Set()
  };

  for (const event of events) {
    if (event.type === "trigger.received") {
      progress.payload = event.payload;
    } else if (event.type === "workflow.run.started") {
      progress.runStartedAt = event.createdAt;

      if (event.inputs) {
        progress.inputs = event.inputs;
      }
    } else if (event.type === "workflow.stage.started") {
      progress.started.add(stageKey(event.stage, event.iteration));
    } else if (event.type === "workflow.stage.dispatched") {
      progress.dispatched.add(stageKey(event.stage, event.iteration));
    } else if (event.type === "workflow.stage.completed") {
      progress.completed.set(stageKey(event.stage, event.iteration), {
        stage: event.stage,
        iteration: event.iteration,
        sessionId: event.sessionId,
        status: event.status,
        output: event.output,
        reason: event.reason
      });
    } else if (event.type === "human.approval.requested" && event.stage && event.iteration) {
      progress.requested.add(stageKey(event.stage, event.iteration));
    } else if (event.type === "human.approval.granted" && event.stage && event.iteration) {
      progress.granted.add(stageKey(event.stage, event.iteration));
    } else if (event.type === "human.approval.denied" && event.stage && event.iteration) {
      progress.denied.set(stageKey(event.stage, event.iteration), event.reason);
    } else if (event.type === "workflow.run.completed") {
      progress.finished = { status: event.status, reason: event.reason };
    }
  }

  return progress;
}

/** Token usage recorded across all stage sessions except one. */
async function usedTokensExcept(
  store: SessionStore,
  workflow: WorkflowData,
  parentSessionId: string,
  exceptSessionId: string
): Promise<number> {
  let total = 0;

  for (const name of Object.keys(workflow.stages ?? {})) {
    const sessionId = `${parentSessionId}/${name}`;

    if (sessionId === exceptSessionId || !(await store.exists(sessionId))) {
      continue;
    }

    total += sumRecordedUsage((await store.getSession(sessionId)).events);
  }

  return total;
}

/** The loop iteration to resume at: one past the deepest completed pass. */
function deriveIteration(progress: WorkflowProgress, loopStages: string[]): number {
  let iteration = 1;

  for (const record of progress.completed.values()) {
    if (loopStages.includes(record.stage) && record.iteration > iteration) {
      iteration = record.iteration;
    }
  }

  return iteration;
}
