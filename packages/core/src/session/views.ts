import type { SessionEvent } from "./events";

export interface TranscriptItem {
  offset: number;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface ToolCallView {
  callId: string;
  toolName: string;
  offset: number;
  status: "pending" | "completed" | "failed";
  args: unknown;
  result?: unknown;
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface RunView {
  runId: string;
  status: "running" | "completed" | "paused" | "failed";
  startedAt: string;
  completedAt?: string;
  steps?: number;
  reason?: string;
  error?: unknown;
}

export interface TimelineItem {
  offset: number;
  type: string;
  label: string;
  severity: "info" | "warning" | "error";
  createdAt: string;
}

export interface PrReviewCommentView {
  id?: string;
  providerId?: string;
  path?: string;
  line?: number;
  body?: string;
  key?: string;
  url?: string;
  offset: number;
}

export interface PrReviewReviewView {
  id?: string;
  providerId?: string;
  repo?: string;
  pr?: number;
  body?: string;
  key?: string;
  url?: string;
  offset: number;
}

export interface PrReviewIdempotencyView {
  callId: string;
  toolName: string;
  key?: string;
  providerCallId?: string;
  providerId?: string;
  status: "pending" | "completed" | "failed";
  offset: number;
}

export interface PrReviewSummaryView {
  repo?: string;
  pr?: number;
  status: "pending" | "running" | "commented" | "submitted" | "paused" | "failed";
  triggers: Array<{
    offset: number;
    source: string;
    kind: string;
    deliveryId?: string;
    createdAt: string;
  }>;
  comments: PrReviewCommentView[];
  reviews: PrReviewReviewView[];
  idempotency: PrReviewIdempotencyView[];
}

export interface SessionView {
  transcript: TranscriptItem[];
  timeline: TimelineItem[];
  tools: ToolCallView[];
  runs: RunView[];
  prReview: PrReviewSummaryView;
}

export function deriveSessionView(events: SessionEvent[]): SessionView {
  return {
    transcript: deriveTranscript(events),
    timeline: deriveTimeline(events),
    tools: deriveToolCalls(events),
    runs: deriveRuns(events),
    prReview: derivePrReviewSummary(events)
  };
}

export function deriveTranscript(events: SessionEvent[]): TranscriptItem[] {
  const transcript: TranscriptItem[] = [];

  for (const event of events) {
    if (event.type === "message.user") {
      transcript.push({
        offset: event.offset,
        role: "user",
        content: event.content,
        createdAt: event.createdAt
      });
      continue;
    }

    if (event.type === "message.assistant") {
      transcript.push({
        offset: event.offset,
        role: "assistant",
        content: event.content,
        createdAt: event.createdAt
      });
      continue;
    }

    if (event.type === "system.note") {
      transcript.push({
        offset: event.offset,
        role: "system",
        content: event.message,
        createdAt: event.createdAt
      });
    }
  }

  return transcript;
}

export function deriveToolCalls(events: SessionEvent[]): ToolCallView[] {
  const calls = new Map<string, ToolCallView>();

  for (const event of events) {
    if (event.type === "tool.call") {
      calls.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        offset: event.offset,
        status: "pending",
        args: event.args,
        startedAt: event.createdAt
      });
      continue;
    }

    if (event.type === "tool.result") {
      const existing = calls.get(event.callId);

      calls.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        offset: existing?.offset ?? event.offset,
        status: "completed",
        args: existing?.args,
        result: event.result,
        startedAt: existing?.startedAt,
        completedAt: event.createdAt
      });
      continue;
    }

    if (event.type === "tool.error") {
      const existing = calls.get(event.callId);

      calls.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        offset: existing?.offset ?? event.offset,
        status: "failed",
        args: existing?.args,
        error: event.error,
        startedAt: existing?.startedAt,
        completedAt: event.createdAt
      });
    }
  }

  return [...calls.values()].sort((left, right) => left.offset - right.offset);
}

export function deriveRuns(events: SessionEvent[]): RunView[] {
  const runs = new Map<string, RunView>();

  for (const event of events) {
    if (event.type === "run.started") {
      runs.set(event.runId, {
        runId: event.runId,
        status: "running",
        startedAt: event.createdAt
      });
      continue;
    }

    if (event.type === "run.completed") {
      const existing = runs.get(event.runId);

      runs.set(event.runId, {
        runId: event.runId,
        status: "completed",
        startedAt: existing?.startedAt ?? event.createdAt,
        completedAt: event.createdAt,
        steps: event.steps
      });
      continue;
    }

    if (event.type === "run.paused") {
      const existing = runs.get(event.runId);

      runs.set(event.runId, {
        runId: event.runId,
        status: "paused",
        startedAt: existing?.startedAt ?? event.createdAt,
        completedAt: event.createdAt,
        steps: event.steps,
        reason: event.reason
      });
      continue;
    }

    if (event.type === "run.failed") {
      const existing = runs.get(event.runId);

      runs.set(event.runId, {
        runId: event.runId,
        status: "failed",
        startedAt: existing?.startedAt ?? event.createdAt,
        completedAt: event.createdAt,
        error: event.error
      });
    }
  }

  return [...runs.values()];
}

export function deriveTimeline(events: SessionEvent[]): TimelineItem[] {
  return events.map((event) => ({
    offset: event.offset,
    type: event.type,
    label: timelineLabel(event),
    severity: timelineSeverity(event),
    createdAt: event.createdAt
  }));
}

export function derivePrReviewSummary(events: SessionEvent[]): PrReviewSummaryView {
  const triggers: PrReviewSummaryView["triggers"] = [];
  const comments: PrReviewCommentView[] = [];
  const reviews: PrReviewReviewView[] = [];
  const idempotency = new Map<string, PrReviewIdempotencyView>();
  let hasRunStarted = false;
  let paused = false;
  let failed = false;
  let repo: string | undefined;
  let pr: number | undefined;

  for (const event of events) {
    if (event.type === "run.started") {
      hasRunStarted = true;
      continue;
    }

    if (event.type === "run.paused") {
      paused = true;
      continue;
    }

    if (event.type === "run.failed" || event.type === "tool.error") {
      failed = true;
    }

    if (event.type === "trigger.received") {
      const payload = readObject(event.payload);
      repo ??= readString(payload, "repo");
      pr ??= readNumber(payload, "pr");
      triggers.push({
        offset: event.offset,
        source: event.source,
        kind: event.kind,
        deliveryId: event.deliveryId,
        createdAt: event.createdAt
      });
      continue;
    }

    if (event.type === "tool.call" && isPrReviewMutationTool(event.toolName)) {
      idempotency.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        key: event.idempotencyKey,
        providerCallId: event.providerCallId,
        status: "pending",
        offset: event.offset
      });
      continue;
    }

    if (event.type === "tool.result" && event.toolName === "post_inline_comment") {
      const result = readObject(event.result);
      const providerId = readString(result, "providerId");
      const key = readString(result, "key");
      comments.push({
        id: readString(result, "id"),
        providerId,
        path: readString(result, "path"),
        line: readNumber(result, "line"),
        body: readString(result, "body"),
        key,
        url: readString(result, "url"),
        offset: event.offset
      });
      recordPrReviewMutationResult(idempotency, event.callId, event.toolName, {
        key,
        providerId,
        offset: event.offset
      });
      continue;
    }

    if (event.type === "tool.result" && event.toolName === "post_review") {
      const result = readObject(event.result);
      const providerId = readString(result, "providerId");
      const key = readString(result, "key");
      reviews.push({
        id: readString(result, "id"),
        providerId,
        repo: readString(result, "repo"),
        pr: readNumber(result, "pr"),
        body: readString(result, "body"),
        key,
        url: readString(result, "url"),
        offset: event.offset
      });
      recordPrReviewMutationResult(idempotency, event.callId, event.toolName, {
        key,
        providerId,
        offset: event.offset
      });
      continue;
    }

    if (event.type === "tool.error" && isPrReviewMutationTool(event.toolName)) {
      const existing = idempotency.get(event.callId);
      idempotency.set(event.callId, {
        callId: event.callId,
        toolName: event.toolName,
        key: existing?.key,
        providerCallId: existing?.providerCallId,
        status: "failed",
        offset: existing?.offset ?? event.offset
      });
    }
  }

  return {
    repo,
    pr,
    status: prReviewStatus({ failed, paused, hasRunStarted, comments, reviews }),
    triggers,
    comments,
    reviews,
    idempotency: [...idempotency.values()].sort((left, right) => left.offset - right.offset)
  };
}

function isPrReviewMutationTool(toolName: string): boolean {
  return (
    toolName === "post_inline_comment" ||
    toolName === "post_review" ||
    toolName === "reply_to_comment"
  );
}

function recordPrReviewMutationResult(
  idempotency: Map<string, PrReviewIdempotencyView>,
  callId: string,
  toolName: string,
  result: { key?: string; providerId?: string; offset: number }
): void {
  if (!isPrReviewMutationTool(toolName)) {
    return;
  }

  const existing = idempotency.get(callId);
  idempotency.set(callId, {
    callId,
    toolName,
    key: existing?.key ?? result.key,
    providerCallId: existing?.providerCallId,
    providerId: result.providerId,
    status: "completed",
    offset: existing?.offset ?? result.offset
  });
}

function prReviewStatus(input: {
  failed: boolean;
  paused: boolean;
  hasRunStarted: boolean;
  comments: PrReviewCommentView[];
  reviews: PrReviewReviewView[];
}): PrReviewSummaryView["status"] {
  if (input.failed) {
    return "failed";
  }

  if (input.paused) {
    return "paused";
  }

  if (input.reviews.length > 0) {
    return "submitted";
  }

  if (input.comments.length > 0) {
    return "commented";
  }

  return input.hasRunStarted ? "running" : "pending";
}

function timelineLabel(event: SessionEvent): string {
  if (event.type === "session.started") {
    return `session started${event.profileName ? `: ${event.profileName}` : ""}`;
  }

  if (event.type === "session.forked") {
    return `forked from ${event.fromSessionId}@${event.atOffset}`;
  }

  if (event.type === "trigger.received") {
    return `trigger ${event.source}:${event.kind}`;
  }

  if (event.type === "message.user") {
    return `user: ${oneLine(event.content)}`;
  }

  if (event.type === "message.assistant") {
    return `assistant: ${oneLine(event.content)}`;
  }

  if (event.type === "tool.call") {
    return `tool call ${event.toolName}`;
  }

  if (event.type === "tool.result") {
    return `tool result ${event.toolName}`;
  }

  if (event.type === "tool.error") {
    return `tool error ${event.toolName}: ${event.error.message}`;
  }

  if (event.type === "run.started") {
    return `run started ${event.runId}`;
  }

  if (event.type === "run.completed") {
    return `run completed (${event.steps} steps)`;
  }

  if (event.type === "run.paused") {
    return `run paused: ${event.reason}`;
  }

  if (event.type === "run.failed") {
    return `run failed: ${event.error.message}`;
  }

  if (event.type === "sandbox.exec.failed") {
    return `sandbox command failed: ${event.command}`;
  }

  if (event.type.startsWith("sandbox.")) {
    return event.type.replace("sandbox.", "sandbox ");
  }

  if (event.type.startsWith("model.")) {
    return event.type.replace("model.", "model ");
  }

  if (event.type === "system.note") {
    return `note: ${oneLine(event.message)}`;
  }

  return event.type;
}

function timelineSeverity(event: SessionEvent): TimelineItem["severity"] {
  if (event.type === "run.failed" || event.type === "tool.error" || event.type === "sandbox.exec.failed") {
    return "error";
  }

  if (event.type === "run.paused") {
    return "warning";
  }

  return "info";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 120);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}
