import { expect, test } from "bun:test";
import type { SessionStore } from "@oma/core";
import {
  createSimulatedGitHubTools,
  hydrateSimulatedGitHubStateFromLog,
  type SimulatedComment,
  type SimulatedGitHubState,
  type SimulatedReview
} from "./index";

const context = { sessionId: "session-a", callId: "call-a" };

function fakeStore(events: Array<Record<string, unknown>>): SessionStore {
  return {
    exists: async () => true,
    getSession: async () => ({ id: "review:owner/repo#42", events })
  } as unknown as SessionStore;
}

function tool(tools: ReturnType<typeof createSimulatedGitHubTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);

  if (!found) {
    throw new Error(`missing tool ${name}`);
  }

  return found;
}

test("hydration populates reviews even when the state map starts absent", async () => {
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };
  const reviewResult: SimulatedReview = {
    id: "review-1",
    providerId: "review-1",
    repo: "owner/repo",
    pr: 42,
    body: "Looks good.",
    event: "COMMENT",
    key: "owner/repo#42:review:COMMENT:Looks good.",
    url: "https://example.test/reviews/review-1"
  };
  const commentResult: SimulatedComment = {
    id: "comment-1",
    providerId: "comment-1",
    path: "src/app.ts",
    line: 12,
    body: "Needs a test.",
    key: "owner/repo#42:src/app.ts:12:missing-test"
  };

  await hydrateSimulatedGitHubStateFromLog(
    fakeStore([
      { type: "tool.result", toolName: "post_review", result: reviewResult },
      { type: "tool.result", toolName: "post_inline_comment", result: commentResult },
      { type: "message.assistant", content: "ignored" }
    ]),
    "review:owner/repo#42",
    state
  );

  expect(state.reviews?.size).toBe(1);
  expect(state.reviews?.get(reviewResult.key)).toMatchObject({ providerId: "review-1" });
  expect(state.comments.get(commentResult.key)).toMatchObject({ providerId: "comment-1" });
});

test("hydrated reviews replay idempotently through the tools (no duplicate post)", async () => {
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };

  await hydrateSimulatedGitHubStateFromLog(
    fakeStore([
      {
        type: "tool.result",
        toolName: "post_review",
        result: {
          id: "review-1",
          providerId: "review-1",
          repo: "owner/repo",
          pr: 42,
          body: "Looks good.",
          event: "COMMENT",
          key: "owner/repo#42:review:COMMENT:Looks good."
        }
      }
    ]),
    "review:owner/repo#42",
    state
  );

  // Tools constructed *after* hydration must see the hydrated review map.
  const tools = createSimulatedGitHubTools(state);
  const postReview = tool(tools, "post_review");
  const args = postReview.schema!.parse({ repo: "owner/repo", pr: 42, body: "Looks good." });
  const replayed = await postReview.handler(args, context);

  expect((replayed as SimulatedReview).providerId).toBe("review-1");
  expect(state.reviews?.size).toBe(1);
});

test("post_review key includes the review event and defaults to COMMENT", async () => {
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };
  const tools = createSimulatedGitHubTools(state);
  const postReview = tool(tools, "post_review");

  const defaulted = postReview.schema!.parse({ repo: "owner/repo", pr: 42, body: "Body." });
  expect(defaulted).toMatchObject({ event: "COMMENT" });
  expect(postReview.idempotencyKey?.(defaulted, context)).toBe(
    "owner/repo#42:review:COMMENT:Body."
  );

  const approve = postReview.schema!.parse({
    repo: "owner/repo",
    pr: 42,
    body: "Body.",
    event: "APPROVE"
  });
  const first = (await postReview.handler(defaulted, context)) as SimulatedReview;
  const second = (await postReview.handler(approve, context)) as SimulatedReview;

  // Same body, different event => distinct reviews with distinct provider ids.
  expect(first.providerId).not.toBe(second.providerId);
  expect(state.reviews?.size).toBe(2);

  const replay = (await postReview.handler(defaulted, context)) as SimulatedReview;
  expect(replay.providerId).toBe(first.providerId);
  expect(state.reviews?.size).toBe(2);
});

test("reply_to_comment takes commentId and assigns unique provider ids per reply", async () => {
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };
  const tools = createSimulatedGitHubTools(state);
  const reply = tool(tools, "reply_to_comment");

  // Schema parity with the real adapter: commentId, not threadId.
  expect(() =>
    reply.schema!.parse({ repo: "owner/repo", pr: 42, threadId: "t1", body: "Hi" })
  ).toThrow();

  const argsA = reply.schema!.parse({
    repo: "owner/repo",
    pr: 42,
    commentId: "101",
    body: "First reply."
  });
  const argsB = reply.schema!.parse({
    repo: "owner/repo",
    pr: 42,
    commentId: "101",
    body: "Second reply."
  });

  expect(reply.idempotencyKey?.(argsA, context)).toBe(
    "owner/repo#42:comment:101:reply:First reply."
  );

  const first = (await reply.handler(argsA, context)) as { providerId: string };
  const second = (await reply.handler(argsB, context)) as { providerId: string };
  const replay = (await reply.handler(argsA, context)) as { providerId: string };

  // Different bodies to the same comment get unique provider ids...
  expect(first.providerId).not.toBe(second.providerId);
  // ...while replaying the same reply is idempotent.
  expect(replay.providerId).toBe(first.providerId);
  expect(state.replies?.size).toBe(2);
});

test("simulated tool schemas stay aligned with the real adapter", () => {
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };
  const tools = createSimulatedGitHubTools(state);

  expect(() =>
    tool(tools, "get_ci_logs").schema!.parse({ repo: "owner/repo", jobId: "42" })
  ).not.toThrow();
  expect(() =>
    tool(tools, "resolve_thread").schema!.parse({ threadId: "PRRT_node123" })
  ).not.toThrow();
});
