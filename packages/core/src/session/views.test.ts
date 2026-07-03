import { expect, test } from "bun:test";
import type { SessionEvent } from "./events";
import {
  derivePrReviewSummary,
  deriveRuns,
  deriveTimeline,
  deriveToolCalls,
  deriveTranscript
} from "./views";

test("deriveTranscript projects readable message items", () => {
  expect(deriveTranscript(events())).toEqual([
    expect.objectContaining({ role: "user", content: "Review this PR", offset: 2 }),
    expect.objectContaining({ role: "assistant", content: "Found one issue", offset: 11 }),
    expect.objectContaining({ role: "system", content: "operator note", offset: 12 })
  ]);
});

test("deriveToolCalls groups calls with terminal result or error state", () => {
  expect(deriveToolCalls(events())).toEqual(expect.arrayContaining([
    expect.objectContaining({
      callId: "call-1",
      toolName: "post_inline_comment",
      status: "completed",
      result: expect.objectContaining({ providerId: "comment-1" })
    }),
    expect.objectContaining({
      callId: "call-2",
      toolName: "run_tests",
      status: "failed",
      error: expect.objectContaining({ message: "boom" })
    }),
    expect.objectContaining({
      callId: "call-3",
      toolName: "get_diff",
      status: "pending"
    })
  ]));
});

test("deriveRuns projects lifecycle status", () => {
  expect(deriveRuns(events())).toEqual([
    expect.objectContaining({ runId: "run-1", status: "failed", error: { message: "failed" } })
  ]);
});

test("deriveTimeline labels important operational events", () => {
  const timeline = deriveTimeline(events());

  expect(timeline).toContainEqual(
    expect.objectContaining({
      type: "trigger.received",
      label: "trigger github:pull_request.opened"
    })
  );
  expect(timeline).toContainEqual(
    expect.objectContaining({
      type: "tool.error",
      severity: "error"
    })
  );
  expect(timeline).toContainEqual(
    expect.objectContaining({
      type: "sandbox.exec.failed",
      severity: "error"
    })
  );
});

test("derivePrReviewSummary extracts review comments and submissions", () => {
  expect(derivePrReviewSummary(events())).toMatchObject({
    repo: "owner/repo",
    pr: 42,
    status: "failed",
    triggers: [{ source: "github", kind: "pull_request.opened" }],
    comments: [
      {
        providerId: "comment-1",
        path: "src/app.ts",
        line: 12,
        body: "Needs a test"
      }
    ],
    reviews: [
      {
        providerId: "review-1",
        repo: "owner/repo",
        pr: 42,
        body: "Found one issue"
      }
    ],
    idempotency: [
      {
        callId: "call-1",
        toolName: "post_inline_comment",
        key: "comment-key",
        providerId: "comment-1",
        status: "completed"
      },
      {
        callId: "review",
        toolName: "post_review",
        key: "review",
        providerId: "review-1",
        status: "completed"
      }
    ]
  });
});

function events(): SessionEvent[] {
  return [
    event(0, { type: "session.started", profileName: "pr-review", mode: "automation" }),
    event(1, {
      type: "trigger.received",
      source: "github",
      kind: "pull_request.opened",
      payload: { repo: "owner/repo", pr: 42 },
      deliveryId: "delivery-1"
    }),
    event(2, { type: "message.user", content: "Review this PR" }),
    event(3, { type: "run.started", runId: "run-1" }),
    event(4, {
      type: "tool.call",
      callId: "call-1",
      toolName: "post_inline_comment",
      args: { path: "src/app.ts" },
      idempotencyKey: "comment-key"
    }),
    event(5, {
      type: "tool.result",
      callId: "call-1",
      toolName: "post_inline_comment",
      result: {
        id: "comment-1",
        providerId: "comment-1",
        path: "src/app.ts",
        line: 12,
        body: "Needs a test",
        key: "k1"
      }
    }),
    event(6, {
      type: "tool.call",
      callId: "call-2",
      toolName: "run_tests",
      args: {}
    }),
    event(7, {
      type: "tool.error",
      callId: "call-2",
      toolName: "run_tests",
      error: { message: "boom" }
    }),
    event(8, {
      type: "tool.call",
      callId: "call-3",
      toolName: "get_diff",
      args: {}
    }),
    event(9, {
      type: "sandbox.exec.failed",
      sandboxId: "local:1",
      command: "bun",
      error: { message: "failed" }
    }),
    event(10, {
      type: "tool.result",
      callId: "review",
      toolName: "post_review",
      result: {
        id: "review-1",
        providerId: "review-1",
        repo: "owner/repo",
        pr: 42,
        body: "Found one issue",
        key: "review"
      }
    }),
    event(11, { type: "message.assistant", content: "Found one issue" }),
    event(12, { type: "system.note", message: "operator note" }),
    event(13, { type: "run.failed", runId: "run-1", error: { message: "failed" } })
  ];
}

function event(offset: number, payload: Record<string, unknown>): SessionEvent {
  return {
    id: `event-${offset}`,
    sessionId: "session-1",
    offset,
    createdAt: `2026-01-01T00:00:${String(offset).padStart(2, "0")}.000Z`,
    ...payload
  } as SessionEvent;
}
