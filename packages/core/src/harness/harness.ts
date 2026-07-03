import { createHash } from "node:crypto";

import type { ModelProvider, ModelTurn } from "../model/provider";
import type { Profile } from "../profiles/profile";
import { validateProfile } from "../profiles/profile";
import {
  errorToRecord,
  type SessionEvent,
  type ToolCallEvent,
  type ToolErrorEvent,
  type ToolResultEvent
} from "../session/events";
import type { SessionId, SessionRecord, SessionStore } from "../session/store";
import {
  findCallApprovalState,
  resolveEffect,
  type EffectsPolicy
} from "../policy/effects";
import { buildContext } from "./context";
import type { WakeLock } from "./wake-lock";
import {
  indexTools,
  parseToolArgs,
  toJsonValue,
  type AnyTool,
  type ToolRegistry
} from "../tools/tool";

export interface HarnessRuntime {
  store: SessionStore;
  model: ModelProvider;
  tools: ToolRegistry;
  wakeLock?: WakeLock;
}

export interface WakeOptions {
  maxSteps?: number;
  /** Hard token ceiling for this session (recorded usage); pauses the run before exceeding it. */
  tokenBudget?: number;
  /** Epoch-ms wall-clock deadline; pauses the run at the first step past it. */
  deadlineAt?: number;
}

export type WaitCondition =
  | { type: "user-input" }
  | { type: "tool-result"; callId: string }
  | { type: "external-signal"; source?: string }
  | { type: "approval"; callId: string; toolName: string };

export type StepResult =
  | { type: "appended"; event: SessionEvent }
  | { type: "waiting"; on: WaitCondition }
  | { type: "done"; reason?: string };

export interface WakeResult {
  sessionId: string;
  events: SessionEvent[];
  steps: number;
  status: "completed" | "failed" | "waiting" | "paused";
  waitingOn?: WaitCondition;
  /** Populated for paused runs: "max-steps", "budget:tokens", "budget:wall". */
  pauseReason?: string;
}

interface ToolCallRequest {
  toolName: string;
  args: unknown;
  providerCallId?: string;
}

// A tool call with its durable id assigned. Ids are computed before the turn
// is persisted in `model.response`, so crash recovery can reconcile exactly
// which of the turn's calls already ran.
interface AssignedToolCall extends ToolCallRequest {
  callId: string;
}

type ModelAction =
  | { type: "message"; content: string }
  | { type: "tool"; content?: string; calls: ToolCallRequest[] }
  | { type: "stop"; reason?: string };

interface RecordedToolTurn {
  content?: string;
  calls: AssignedToolCall[];
}

export async function wake(
  runtime: HarnessRuntime,
  sessionId: SessionId,
  profile: Profile,
  options: WakeOptions = {}
): Promise<WakeResult> {
  const validated = validateRuntimeProfile(profile, runtime.tools);
  const run = () => wakeUnlocked(runtime, sessionId, validated, options);

  if (runtime.wakeLock) {
    return runtime.wakeLock.withSessionLock(sessionId, run);
  }

  return run();
}

async function wakeUnlocked(
  runtime: HarnessRuntime,
  sessionId: SessionId,
  profile: Profile,
  options: WakeOptions
): Promise<WakeResult> {
  const maxSteps = options.maxSteps ?? profile.policy.maxSteps ?? 32;
  const runId = crypto.randomUUID();
  let steps = 0;

  const initial = await runtime.store.getSession(sessionId);
  const session: SessionRecord = { ...initial, events: [...initial.events] };
  let nextOffset = (session.events.at(-1)?.offset ?? -1) + 1;
  let usedTokens = sumRecordedUsage(session.events);

  // Each iteration fetches only events appended since the last read, so a wake
  // is O(total events) in store reads instead of O(steps * total events) —
  // while still picking up concurrent appends (e.g. `send` while running).
  const syncSession = async () => {
    const delta = await runtime.store.getSession(sessionId, { fromOffset: nextOffset });
    session.events.push(...delta.events);
    usedTokens += sumRecordedUsage(delta.events);
    nextOffset = (session.events.at(-1)?.offset ?? -1) + 1;
  };

  const pause = async (reason: string): Promise<WakeResult> => {
    await runtime.store.appendEvent(sessionId, {
      type: "run.paused",
      runId,
      steps,
      reason
    });
    await syncSession();
    return { sessionId, events: session.events, steps, status: "paused", pauseReason: reason };
  };

  try {
    await runtime.store.appendEvent(sessionId, {
      type: "run.started",
      runId
    });

    while (steps < maxSteps) {
      await syncSession();

      // Budgets are hard stops checked harness-side before spending anything
      // else. A paused run is resumable: raise the budget (or wait) and wake.
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        return pause("budget:wall");
      }

      if (options.tokenBudget !== undefined && usedTokens >= options.tokenBudget) {
        return pause(`budget:tokens (used ${usedTokens} of ${options.tokenBudget})`);
      }

      const result = await step(runtime, session, profile);

      if (result.type === "waiting") {
        await runtime.store.appendEvent(sessionId, {
          type: "run.paused",
          runId,
          steps,
          reason: `waiting:${result.on.type}`
        });
        await syncSession();
        return {
          sessionId,
          events: session.events,
          steps,
          status: "waiting",
          waitingOn: result.on
        };
      }

      if (result.type === "done") {
        await runtime.store.appendEvent(sessionId, {
          type: "run.completed",
          runId,
          steps
        });
        await syncSession();
        return { sessionId, events: session.events, steps, status: "completed" };
      }

      steps += 1;
    }

    return pause("max-steps");
  } catch (error) {
    await runtime.store.appendEvent(sessionId, {
      type: "run.failed",
      runId,
      error: errorToRecord(error)
    });
    await syncSession();
    return { sessionId, events: session.events, steps, status: "failed" };
  }
}

export async function step(
  runtime: HarnessRuntime,
  session: SessionRecord,
  profile: Profile
): Promise<StepResult> {
  // A recorded `model.response` is the durable record of the whole turn. If a
  // crash interrupted it partway — assistant text not yet appended, or some of
  // its tool calls never started — finish that turn before consulting the
  // model again, or the un-started calls would be silently lost.
  const unfinishedTurn = findUnfinishedToolTurn(session.events);

  if (unfinishedTurn) {
    const outcome = await runToolTurn(runtime, session, profile, unfinishedTurn);
    return "waiting" in outcome ? { type: "waiting", on: outcome.waiting } : { type: "appended", event: outcome.event };
  }

  const pendingToolCall = findPendingToolCall(session.events);

  if (pendingToolCall) {
    const outcome = await executeCallWithPolicy(
      runtime,
      session,
      profile,
      pendingToolCall,
      session.events
    );
    return "waiting" in outcome ? { type: "waiting", on: outcome.waiting } : { type: "appended", event: outcome.event };
  }

  const context = buildContext(session, profile);

  await runtime.store.appendEvent(session.id, {
    type: "model.request",
    provider: runtime.model.info?.provider,
    metadata: {
      model: runtime.model.info?.model,
      profile: profile.name,
      mode: profile.mode,
      events: context.events.length,
      truncated: context.truncated,
      toolCount: profile.tools.length
    }
  });

  let turn: ModelTurn;

  try {
    turn = await runtime.model.turn({
      events: session.events,
      profile,
      context,
      tools: runtime.tools
    });
  } catch (error) {
    await runtime.store.appendEvent(session.id, {
      type: "model.error",
      error: errorToRecord(error)
    });
    throw error;
  }

  const action = interpretModelTurn(turn);
  const toolTurn: RecordedToolTurn | undefined =
    action.type === "tool"
      ? { content: action.content, calls: assignCallIds(session.events, action.calls) }
      : undefined;

  await runtime.store.appendEvent(session.id, {
    type: "model.response",
    turn: toJsonValue(compactModelTurn(turn), "model.response.turn"),
    action: toJsonValue(compactModelAction(action, toolTurn), "model.response.action")
  });

  if (action.type === "stop") {
    return { type: "done", reason: action.reason };
  }

  if (action.type === "message") {
    const event = await runtime.store.appendEvent(session.id, {
      type: "message.assistant",
      content: action.content
    });
    return { type: "appended", event };
  }

  const outcome = await runToolTurn(runtime, session, profile, toolTurn as RecordedToolTurn);
  return "waiting" in outcome ? { type: "waiting", on: outcome.waiting } : { type: "appended", event: outcome.event };
}

// Executes a tool turn — fresh or resumed after a crash. Each call is skipped
// if its terminal is already recorded, completed if its `tool.call` exists
// without a terminal, and otherwise appended and executed. The turn's
// assistant text is appended once.
async function runToolTurn(
  runtime: HarnessRuntime,
  session: SessionRecord,
  profile: Profile,
  turn: RecordedToolTurn
): Promise<{ event: SessionEvent } | { waiting: WaitCondition }> {
  const seen = [...session.events];
  let lastEvent: SessionEvent | undefined;

  if (turn.content && !hasRecordedAssistantContent(seen, turn.content)) {
    lastEvent = await runtime.store.appendEvent(session.id, {
      type: "message.assistant",
      content: turn.content
    });
  }

  for (const request of turn.calls) {
    assertProfileAllowsTool(profile, request.toolName);
    const recorded = findRecordedToolTerminal(seen, request.callId);

    if (recorded) {
      // Already executed — replay reads the recorded terminal, never re-runs.
      lastEvent = recorded;
      continue;
    }

    let call = findRecordedToolCall(seen, request.callId);

    if (!call) {
      const tool = requireTool(runtime.tools, request.toolName);
      const args = toJsonValue(parseToolArgs(tool, request.args), "tool.call.args");
      const contextForKey = { sessionId: session.id, callId: request.callId };
      const idempotencyKey = tool.idempotencyKey?.(args, contextForKey);

      call = (await runtime.store.appendEvent(session.id, {
        type: "tool.call",
        callId: request.callId,
        toolName: request.toolName,
        args,
        providerCallId: request.providerCallId,
        idempotencyKey
      })) as ToolCallEvent;
      seen.push(call);
    }

    const outcome = await executeCallWithPolicy(runtime, session, profile, call, seen);

    if ("waiting" in outcome) {
      return outcome;
    }

    seen.push(outcome.event);
    lastEvent = outcome.event;
  }

  if (!lastEvent) {
    throw new Error("Tool turn produced no events; model emitted an empty call list");
  }

  return { event: lastEvent };
}

/**
 * The effects gate, enforced at execution time — after the `tool.call` is
 * durable (so approvals have the exact args on record) and outside the model.
 * Denials become tool.error terminals the model can read and adapt to; they
 * never throw, because a policy denial is expected behavior, not a failure.
 */
async function executeCallWithPolicy(
  runtime: HarnessRuntime,
  session: SessionRecord,
  profile: Profile,
  call: ToolCallEvent,
  seen: SessionEvent[]
): Promise<{ event: SessionEvent } | { waiting: WaitCondition }> {
  const tool = indexTools(runtime.tools).get(call.toolName);
  const resolution = resolveEffect(
    profile.policy.effects as EffectsPolicy | undefined,
    tool,
    { toolName: call.toolName, callId: call.callId, args: call.args },
    seen
  );

  if (resolution.kind === "deny") {
    const event = await runtime.store.appendEvent(session.id, {
      type: "tool.error",
      callId: call.callId,
      toolName: call.toolName,
      error: { name: "EffectDenied", message: resolution.reason },
      retryable: false
    });
    return { event };
  }

  if (resolution.kind === "dedupe") {
    const event = await runtime.store.appendEvent(session.id, {
      type: "tool.result",
      callId: call.callId,
      toolName: call.toolName,
      result: toJsonValue(resolution.result, "tool.result"),
      metadata: { deduplicated: true, fromCallId: resolution.fromCallId }
    });
    return { event };
  }

  if (resolution.kind === "approve") {
    const approval = findCallApprovalState(seen, call.callId);

    if (approval === "denied") {
      const event = await runtime.store.appendEvent(session.id, {
        type: "tool.error",
        callId: call.callId,
        toolName: call.toolName,
        error: {
          name: "EffectDenied",
          message: `Approval for tool "${call.toolName}" was denied.`
        },
        retryable: false
      });
      return { event };
    }

    if (approval !== "granted") {
      if (approval === "none") {
        await runtime.store.appendEvent(session.id, {
          type: "human.approval.requested",
          callId: call.callId,
          toolName: call.toolName,
          summary: summarizeArgs(call.args)
        });
      }

      return { waiting: { type: "approval", callId: call.callId, toolName: call.toolName } };
    }
  }

  const event = await executeAndRecordTool(runtime, session.id, call, profile);
  return { event };
}

const maxApprovalSummaryBytes = 2_000;

function summarizeArgs(args: unknown): string | undefined {
  try {
    return JSON.stringify(args)?.slice(0, maxApprovalSummaryBytes);
  } catch {
    return undefined;
  }
}

/** Total recorded model token usage (totalTokens, else input+output) in these events. */
export function sumRecordedUsage(events: SessionEvent[]): number {
  let total = 0;

  for (const event of events) {
    if (event.type !== "model.response") {
      continue;
    }

    const usage = (event.turn as { usage?: Record<string, unknown> } | undefined)?.usage;

    if (!usage) {
      continue;
    }

    const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
    const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
    const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;

    total += totalTokens ?? inputTokens + outputTokens;
  }

  return total;
}

// Reads the last recorded model.response back as a tool turn, or undefined if
// the turn completed (all calls terminal, assistant text appended) or the
// action was not a tool turn.
function findUnfinishedToolTurn(events: SessionEvent[]): RecordedToolTurn | undefined {
  const response = [...events]
    .reverse()
    .find((event) => event.type === "model.response");

  if (!response || response.type !== "model.response") {
    return undefined;
  }

  const turn = parseRecordedToolTurn(response.action);

  if (!turn) {
    return undefined;
  }

  const contentMissing =
    turn.content !== undefined && !hasRecordedAssistantContent(events, turn.content);
  const callsMissing = turn.calls.some(
    (call) => !findRecordedToolTerminal(events, call.callId)
  );

  return contentMissing || callsMissing ? turn : undefined;
}

function parseRecordedToolTurn(value: unknown): RecordedToolTurn | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const action = value as Record<string, unknown>;

  if (action.type !== "tool" || !Array.isArray(action.calls) || action.calls.length === 0) {
    return undefined;
  }

  const calls: AssignedToolCall[] = [];

  for (const item of action.calls) {
    if (!item || typeof item !== "object") {
      return undefined;
    }

    const call = item as Record<string, unknown>;

    if (typeof call.toolName !== "string" || typeof call.callId !== "string") {
      return undefined;
    }

    calls.push({
      toolName: call.toolName,
      args: call.args,
      callId: call.callId,
      ...(typeof call.providerCallId === "string" ? { providerCallId: call.providerCallId } : {})
    });
  }

  return {
    ...(typeof action.content === "string" ? { content: action.content } : {}),
    calls
  };
}

function hasRecordedAssistantContent(events: SessionEvent[], content: string): boolean {
  return events.some(
    (event) => event.type === "message.assistant" && event.content === content
  );
}

function findRecordedToolCall(events: SessionEvent[], callId: string): ToolCallEvent | undefined {
  return events.find(
    (event): event is ToolCallEvent => event.type === "tool.call" && event.callId === callId
  );
}

export function interpretModelTurn(turn: ModelTurn): ModelAction {
  const calls = (turn.toolCalls ?? []).map(
    (call): ToolCallRequest => ({
      toolName: call.name,
      args: call.args,
      ...(call.id ? { providerCallId: call.id } : {})
    })
  );

  if (calls.length > 0) {
    return {
      type: "tool",
      ...(turn.content ? { content: turn.content } : {}),
      calls
    };
  }

  if (turn.content) {
    return { type: "message", content: turn.content };
  }

  return { type: "stop", reason: turn.finishReason };
}

export function findRecordedToolResult(
  events: SessionEvent[],
  callId: string
): ToolResultEvent | undefined {
  return events.find(
    (event): event is ToolResultEvent => event.type === "tool.result" && event.callId === callId
  );
}

export function findRecordedToolError(
  events: SessionEvent[],
  callId: string
): ToolErrorEvent | undefined {
  return events.find(
    (event): event is ToolErrorEvent => event.type === "tool.error" && event.callId === callId
  );
}

export function findRecordedToolTerminal(
  events: SessionEvent[],
  callId: string
): ToolResultEvent | ToolErrorEvent | undefined {
  return findRecordedToolResult(events, callId) ?? findRecordedToolError(events, callId);
}

function findPendingToolCall(events: SessionEvent[]): ToolCallEvent | undefined {
  return events.find(
    (event): event is ToolCallEvent =>
      event.type === "tool.call" && !findRecordedToolTerminal(events, event.callId)
  );
}

async function executeAndRecordTool(
  runtime: HarnessRuntime,
  sessionId: string,
  call: ToolCallEvent,
  profile: Profile
): Promise<SessionEvent> {
  try {
    const result = await executeTool(runtime.tools, call);
    return runtime.store.appendEvent(sessionId, {
      type: "tool.result",
      callId: call.callId,
      toolName: call.toolName,
      result: toJsonValue(result, "tool.result")
    });
  } catch (error) {
    const event = await runtime.store.appendEvent(sessionId, {
      type: "tool.error",
      callId: call.callId,
      toolName: call.toolName,
      error: errorToRecord(error)
    });

    if (profile.policy.toolError !== "continue") {
      throw error;
    }

    return event;
  }
}

async function executeTool(tools: ToolRegistry, call: ToolCallEvent): Promise<unknown> {
  const tool = requireTool(tools, call.toolName);
  const args = parseToolArgs(tool, call.args);
  const context = {
    sessionId: call.sessionId,
    callId: call.callId,
    idempotencyKey: call.idempotencyKey
  };
  return tool.handler(args, context);
}

function requireTool(tools: ToolRegistry, name: string): AnyTool {
  const tool = indexTools(tools).get(name);

  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }

  return tool;
}

export function validateRuntimeProfile(profile: Profile, tools: ToolRegistry): Profile {
  const validated = validateProfile(profile);
  const registry = indexTools(tools);

  for (const toolName of validated.tools) {
    if (!registry.has(toolName)) {
      throw new Error(`Profile "${validated.name}" references missing tool: ${toolName}`);
    }
  }

  return validated;
}

function assertProfileAllowsTool(profile: Profile, toolName: string): void {
  if (!profile.tools.includes(toolName)) {
    throw new Error(`Model requested undeclared tool "${toolName}" for profile "${profile.name}"`);
  }
}

// Providers that supply call ids get them verbatim — they are unique per
// emission. The fallback id is occurrence-indexed so a model that legitimately
// repeats a call (same tool, same args) gets a fresh id and a fresh execution,
// while a re-emitted id still replays its recorded terminal. Ids are assigned
// for the whole turn up front, before the turn is persisted, so recovery can
// reconcile the recorded ids instead of recomputing them against a log that
// has since grown.
function assignCallIds(events: SessionEvent[], calls: ToolCallRequest[]): AssignedToolCall[] {
  const assigned: AssignedToolCall[] = [];

  for (const call of calls) {
    if (call.providerCallId) {
      assigned.push({ ...call, callId: call.providerCallId });
      continue;
    }

    const digest = createHash("sha256")
      .update(stableStringify(call.args) ?? "undefined")
      .digest("hex")
      .slice(0, 16);
    const prefix = `${call.toolName}:${digest}#`;
    let occurrence = 0;

    for (const event of events) {
      if (event.type === "tool.call" && event.callId.startsWith(prefix)) {
        occurrence += 1;
      }
    }

    for (const earlier of assigned) {
      if (earlier.callId.startsWith(prefix)) {
        occurrence += 1;
      }
    }

    assigned.push({ ...call, callId: `${prefix}${occurrence}` });
  }

  return assigned;
}

function compactModelTurn(turn: ModelTurn): Record<string, unknown> {
  return {
    ...(turn.content !== undefined ? { content: turn.content } : {}),
    ...(turn.toolCalls !== undefined
      ? {
          toolCalls: turn.toolCalls.map((call) => ({
            ...(call.id !== undefined ? { id: call.id } : {}),
            name: call.name,
            args: call.args
          }))
        }
      : {}),
    ...(turn.finishReason !== undefined ? { finishReason: turn.finishReason } : {}),
    ...(turn.usage !== undefined
      ? {
          usage: {
            ...(turn.usage.inputTokens !== undefined ? { inputTokens: turn.usage.inputTokens } : {}),
            ...(turn.usage.outputTokens !== undefined ? { outputTokens: turn.usage.outputTokens } : {}),
            ...(turn.usage.totalTokens !== undefined ? { totalTokens: turn.usage.totalTokens } : {})
          }
        }
      : {}),
    ...(turn.requestId !== undefined ? { requestId: turn.requestId } : {})
    // turn.raw stays in-process only: the full provider response is unbounded
    // and must not enter the append-only log.
  };
}

function compactModelAction(
  action: ModelAction,
  toolTurn?: RecordedToolTurn
): Record<string, unknown> {
  if (action.type === "tool" && toolTurn) {
    return {
      type: action.type,
      ...(toolTurn.content !== undefined ? { content: toolTurn.content } : {}),
      calls: toolTurn.calls.map((call) => ({
        toolName: call.toolName,
        args: call.args,
        callId: call.callId,
        ...(call.providerCallId !== undefined ? { providerCallId: call.providerCallId } : {})
      }))
    };
  }

  if (action.type === "tool") {
    throw new Error("Tool actions must be persisted with assigned call ids");
  }

  if (action.type === "message") {
    return {
      type: action.type,
      content: action.content
    };
  }

  return {
    type: action.type,
    ...(action.reason !== undefined ? { reason: action.reason } : {})
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)])
    );
  }

  return value;
}
