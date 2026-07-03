import { expect, test } from "bun:test";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { MemoryWakeLock, spawn, wake } from "@oma/core";
import {
  createPrReviewTools,
  runPrReviewSimulation,
  type SimulatedComment,
  simulatedPrReviewProfile
} from "./index";

test("simulated PR review uses a keyed durable session and idempotent comments", async () => {
  const store = new MemorySessionStore();
  const result = await runPrReviewSimulation({ store });
  const session = await store.getSession(result.sessionId);
  const triggerEvents = session.events.filter((event) => event.type === "trigger.received");
  const keys = result.comments.map((comment) => comment.key);

  expect(result.sessionId).toBe("review:owner/repo#42");
  expect(result.comments).toHaveLength(2);
  expect(new Set(keys).size).toBe(keys.length);
  expect(triggerEvents).toHaveLength(2);
  expect(await store.exists(result.forkId)).toBe(true);
});

test("simulated PR review is repeatable against the same configured store", async () => {
  const store = new MemorySessionStore();
  const first = await runPrReviewSimulation({ store });
  const second = await runPrReviewSimulation({ store });

  expect(first.sessionId).toBe("review:owner/repo#42");
  expect(second.sessionId).toBe("review:owner/repo#42");
  expect(first.comments).toHaveLength(2);
  expect(second.comments).toHaveLength(2);
  expect(second.comments.map((comment) => comment.key).sort()).toEqual(
    first.comments.map((comment) => comment.key).sort()
  );
});

test("simulated PR review replay makes crash-window mutation safe through tool idempotency", async () => {
  const comments = new Map<string, SimulatedComment>();
  const key = "owner/repo#42:src/app.ts:12:missing-test";
  const store = new MemorySessionStore();
  const profile = simulatedPrReviewProfile();
  const sessionId = await spawn(store, profile, { id: "review:owner/repo#42" });

  comments.set(key, {
    id: "comment-1",
    providerId: "comment-1",
    path: "src/app.ts",
    line: 12,
    body: "Already posted before the result event was recorded.",
    key
  });
  await store.appendEvent(sessionId, {
    type: "tool.call",
    callId: "post-inline-1",
    toolName: "post_inline_comment",
    args: {
      key,
      path: "src/app.ts",
      line: 12,
      body: "Already posted before the result event was recorded."
    },
    idempotencyKey: key
  });

  await wake(
    {
      store,
      tools: createPrReviewTools(comments),
      model: new FakeModelProvider([{ finishReason: "done" }]),
      wakeLock: new MemoryWakeLock()
    },
    sessionId,
    profile
  );

  const session = await store.getSession(sessionId);

  expect(comments.size).toBe(1);
  expect(session.events.some((event) => event.type === "tool.result")).toBe(true);
});
