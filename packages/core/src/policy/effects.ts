import { createHash } from "node:crypto";
import type { SessionEvent } from "../session/events";
import type { AnyTool } from "../tools/tool";

export type EffectDecision = "allow" | "approve" | "deny";

export interface EffectRuleObject {
  decision?: EffectDecision;
  /** Cap on real executions of this tool per session (deduped replays excluded). */
  max?: number;
  /** Identical calls (same tool, same args) return the recorded result instead of re-executing. */
  dedupe?: boolean;
  reason?: string;
}

export type EffectRule = EffectDecision | EffectRuleObject;

/**
 * Keys are tool-name patterns: exact (`post_review`), prefix wildcard
 * (`post_*`), or catch-all (`*`). Exact beats longest-prefix beats catch-all.
 */
export type EffectsPolicy = Record<string, EffectRule>;

export type EffectResolution =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approve" }
  | { kind: "dedupe"; result: unknown; fromCallId: string };

export interface EffectCall {
  toolName: string;
  callId: string;
  args: unknown;
}

/**
 * The policy gate, evaluated harness-side at execution time — the model never
 * sees or negotiates it. Defaults when an effects block exists: reads are
 * allowed, everything else must be declared ("blast radius readable from the
 * YAML"). Without an effects block, behavior is unchanged (allow).
 */
export function resolveEffect(
  policy: EffectsPolicy | undefined,
  tool: AnyTool | undefined,
  call: EffectCall,
  events: SessionEvent[]
): EffectResolution {
  if (!policy) {
    return { kind: "allow" };
  }

  const rule = matchEffectRule(policy, call.toolName);

  if (!rule) {
    if (tool?.effect === "read") {
      return { kind: "allow" };
    }

    return {
      kind: "deny",
      reason: `Effects policy declares no rule for ${tool?.effect ?? "undeclared-effect"} tool "${call.toolName}"; reads are allowed by default, writes must be declared.`
    };
  }

  const normalized: EffectRuleObject = typeof rule === "string" ? { decision: rule } : rule;
  const decision = normalized.decision ?? "allow";

  if (decision === "deny") {
    return {
      kind: "deny",
      reason: normalized.reason ?? `Effects policy denies tool "${call.toolName}".`
    };
  }

  if (normalized.dedupe) {
    const previous = findDuplicateResult(events, call);

    if (previous) {
      return { kind: "dedupe", result: previous.result, fromCallId: previous.callId };
    }
  }

  if (normalized.max !== undefined) {
    const executions = countExecutions(events, call.toolName);

    if (executions >= normalized.max) {
      return {
        kind: "deny",
        reason: `Effects policy caps tool "${call.toolName}" at ${normalized.max} execution${normalized.max === 1 ? "" : "s"}; ${executions} already recorded.`
      };
    }
  }

  return decision === "approve" ? { kind: "approve" } : { kind: "allow" };
}

export function matchEffectRule(policy: EffectsPolicy, toolName: string): EffectRule | undefined {
  if (policy[toolName] !== undefined) {
    return policy[toolName];
  }

  let best: { prefix: string; rule: EffectRule } | undefined;

  for (const [pattern, rule] of Object.entries(policy)) {
    if (pattern === "*" || !pattern.endsWith("*")) {
      continue;
    }

    const prefix = pattern.slice(0, -1);

    if (toolName.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
      best = { prefix, rule };
    }
  }

  if (best) {
    return best.rule;
  }

  return policy["*"];
}

export type ApprovalState = "granted" | "denied" | "requested" | "none";

/** Latest human decision recorded for a gated tool call, matched by callId. */
export function findCallApprovalState(events: SessionEvent[], callId: string): ApprovalState {
  let state: ApprovalState = "none";

  for (const event of events) {
    if (event.type === "human.approval.granted" && event.callId === callId) {
      state = "granted";
    } else if (event.type === "human.approval.denied" && event.callId === callId) {
      state = "denied";
    } else if (
      event.type === "human.approval.requested" &&
      event.callId === callId &&
      state === "none"
    ) {
      state = "requested";
    }
  }

  return state;
}

/** Real executions only: deduped results replay a prior effect, they are not one. */
function countExecutions(events: SessionEvent[], toolName: string): number {
  let count = 0;

  for (const event of events) {
    if (
      event.type === "tool.result" &&
      event.toolName === toolName &&
      event.metadata?.deduplicated !== true
    ) {
      count += 1;
    }
  }

  return count;
}

function findDuplicateResult(
  events: SessionEvent[],
  call: EffectCall
): { result: unknown; callId: string } | undefined {
  const wanted = argsDigest(call.args);
  const argsByCallId = new Map<string, string>();

  for (const event of events) {
    if (event.type === "tool.call" && event.toolName === call.toolName) {
      argsByCallId.set(event.callId, argsDigest(event.args));
    }
  }

  for (const event of events) {
    if (
      event.type === "tool.result" &&
      event.toolName === call.toolName &&
      event.callId !== call.callId &&
      argsByCallId.get(event.callId) === wanted
    ) {
      return { result: event.result, callId: event.callId };
    }
  }

  return undefined;
}

export function argsDigest(args: unknown): string {
  return createHash("sha256").update(stableStringify(args) ?? "undefined").digest("hex");
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
