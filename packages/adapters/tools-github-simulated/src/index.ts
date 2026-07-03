import { defineTool, type AnyTool, type SessionStore } from "@oma/core";
import { z } from "zod";

export interface SimulatedComment {
  id: string;
  providerId: string;
  path: string;
  line: number;
  body: string;
  key: string;
  url?: string;
}

export interface SimulatedReview {
  id: string;
  providerId: string;
  repo: string;
  pr: number;
  body: string;
  event: string;
  key: string;
  url?: string;
}

export interface SimulatedReply {
  id: string;
  providerId: string;
  repo: string;
  pr: number;
  commentId: string;
  body: string;
  key: string;
}

export interface SimulatedGitHubState {
  comments: Map<string, SimulatedComment>;
  reviews?: Map<string, SimulatedReview>;
  replies?: Map<string, SimulatedReply>;
}

export async function hydrateSimulatedGitHubStateFromLog(
  store: SessionStore,
  sessionId: string,
  state: SimulatedGitHubState
): Promise<void> {
  if (!(await store.exists(sessionId))) {
    return;
  }

  const reviews = ensureReviews(state);
  const replies = ensureReplies(state);
  const session = await store.getSession(sessionId);

  for (const event of session.events) {
    if (event.type !== "tool.result") {
      continue;
    }

    if (event.toolName === "post_inline_comment") {
      const comment = parseSimulatedComment(event.result);

      if (comment) {
        state.comments.set(comment.key, comment);
      }
    }

    if (event.toolName === "post_review") {
      const review = parseSimulatedReview(event.result);

      if (review) {
        reviews.set(review.key, review);
      }
    }

    if (event.toolName === "reply_to_comment") {
      const reply = parseSimulatedReply(event.result);

      if (reply) {
        replies.set(reply.key, reply);
      }
    }
  }
}

export function createSimulatedGitHubTools(state: SimulatedGitHubState): AnyTool[] {
  const reviews = ensureReviews(state);
  const replies = ensureReplies(state);

  return [
    defineTool({
      name: "get_pr_metadata",
      effect: "read",
      capabilities: ["github.pr.metadata"],
      schema: z.object({
        repo: z.string(),
        pr: z.number().int()
      }),
      handler: async ({ repo, pr }) => ({
        repo,
        pr,
        title: "Simulated regression in app behavior",
        author: "dev",
        head: "abc123",
        base: "main"
      })
    }),
    defineTool({
      name: "get_diff",
      effect: "read",
      capabilities: ["github.pr.diff"],
      schema: z.object({
        repo: z.string(),
        pr: z.number().int()
      }),
      handler: async () => ({
        diff:
          "diff --git a/src/app.ts b/src/app.ts\n@@ -9,6 +9,7 @@\n export function canShip(hasTests: boolean) {\n+  if (!hasTests) return false;\n   return true;\n }\n"
      })
    }),
    defineTool({
      name: "get_file_at_ref",
      effect: "read",
      capabilities: ["github.file.read"],
      schema: z.object({
        path: z.string(),
        ref: z.string()
      }),
      handler: async ({ path, ref }) => ({
        path,
        ref,
        content: "export function canShip(hasTests: boolean) { return hasTests; }\n"
      })
    }),
    defineTool({
      name: "get_prior_comments",
      effect: "read",
      capabilities: ["github.comment.list"],
      schema: z.object({
        repo: z.string().optional(),
        pr: z.number().int().optional()
      }),
      handler: async () => ({
        comments: [...state.comments.values()]
      })
    }),
    defineTool({
      name: "get_review_threads",
      effect: "read",
      capabilities: ["github.thread.list"],
      schema: z.object({
        repo: z.string(),
        pr: z.number().int()
      }),
      handler: async () => ({ threads: [] })
    }),
    defineTool({
      name: "get_ci_status",
      effect: "read",
      capabilities: ["github.ci.status"],
      schema: z.object({
        repo: z.string(),
        ref: z.string()
      }),
      handler: async () => ({ state: "success", checks: [] })
    }),
    defineTool({
      name: "get_ci_logs",
      effect: "read",
      capabilities: ["github.ci.logs"],
      schema: z.object({
        repo: z.string(),
        jobId: z.string()
      }),
      handler: async () => ({ logs: "", truncated: false })
    }),
    defineTool({
      name: "post_inline_comment",
      effect: "external",
      capabilities: ["github.comment.write"],
      schema: z.object({
        key: z.string().min(1),
        path: z.string().min(1),
        line: z.number().int().positive(),
        body: z.string().min(1)
      }),
      idempotencyKey: ({ key }) => key,
      handler: async ({ key, path, line, body }) => {
        const existing = state.comments.get(key);

        if (existing) {
          return existing;
        }

        const providerId = `comment-${state.comments.size + 1}`;
        const comment = {
          id: providerId,
          providerId,
          path,
          line,
          body,
          key,
          url: `https://example.test/comments/${providerId}`
        };

        state.comments.set(key, comment);
        return comment;
      }
    }),
    defineTool({
      name: "post_review",
      effect: "external",
      capabilities: ["github.review.write"],
      schema: z.object({
        repo: z.string(),
        pr: z.number().int(),
        body: z.string().min(1),
        event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]).default("COMMENT")
      }),
      idempotencyKey: ({ repo, pr, body, event }) =>
        `${repo}#${pr}:review:${event ?? "COMMENT"}:${body}`,
      handler: async ({ repo, pr, body, event: rawEvent }) => {
        // The harness parses args through the schema, so the default always
        // applies at runtime; the fallback keeps the inferred type strict.
        const event = rawEvent ?? "COMMENT";
        const key = `${repo}#${pr}:review:${event}:${body}`;
        const existing = reviews.get(key);

        if (existing) {
          return existing;
        }

        const providerId = `review-${reviews.size + 1}`;
        const review = {
          id: providerId,
          providerId,
          repo,
          pr,
          body,
          event,
          key,
          url: `https://example.test/reviews/${providerId}`
        };

        reviews.set(key, review);
        return review;
      }
    }),
    defineTool({
      name: "reply_to_comment",
      effect: "external",
      capabilities: ["github.comment.write"],
      schema: z.object({
        repo: z.string(),
        pr: z.number().int(),
        commentId: z.string(),
        body: z.string().min(1)
      }),
      idempotencyKey: ({ repo, pr, commentId, body }) =>
        `${repo}#${pr}:comment:${commentId}:reply:${body}`,
      handler: async ({ repo, pr, commentId, body }) => {
        const key = `${repo}#${pr}:comment:${commentId}:reply:${body}`;
        const existing = replies.get(key);

        if (existing) {
          return existing;
        }

        const providerId = `reply-${replies.size + 1}`;
        const reply = {
          id: providerId,
          providerId,
          repo,
          pr,
          commentId,
          body,
          key
        };

        replies.set(key, reply);
        return reply;
      }
    }),
    defineTool({
      name: "resolve_thread",
      effect: "external",
      capabilities: ["github.thread.resolve"],
      schema: z.object({
        threadId: z.string()
      }),
      idempotencyKey: ({ threadId }) => `${threadId}:resolve`,
      handler: async ({ threadId }) => ({
        id: threadId,
        providerId: threadId,
        resolved: true
      })
    })
  ];
}

function ensureReviews(state: SimulatedGitHubState): Map<string, SimulatedReview> {
  state.reviews ??= new Map<string, SimulatedReview>();
  return state.reviews;
}

function ensureReplies(state: SimulatedGitHubState): Map<string, SimulatedReply> {
  state.replies ??= new Map<string, SimulatedReply>();
  return state.replies;
}

function parseSimulatedComment(value: unknown): SimulatedComment | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.line !== "number" ||
    typeof candidate.body !== "string" ||
    typeof candidate.key !== "string"
  ) {
    return undefined;
  }

  return {
    id: candidate.id,
    providerId:
      typeof candidate.providerId === "string" ? candidate.providerId : candidate.id,
    path: candidate.path,
    line: candidate.line,
    body: candidate.body,
    key: candidate.key,
    url: typeof candidate.url === "string" ? candidate.url : undefined
  };
}

function parseSimulatedReview(value: unknown): SimulatedReview | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.repo !== "string" ||
    typeof candidate.pr !== "number" ||
    typeof candidate.body !== "string" ||
    typeof candidate.key !== "string"
  ) {
    return undefined;
  }

  return {
    id: candidate.id,
    providerId:
      typeof candidate.providerId === "string" ? candidate.providerId : candidate.id,
    repo: candidate.repo,
    pr: candidate.pr,
    body: candidate.body,
    event: typeof candidate.event === "string" ? candidate.event : "COMMENT",
    key: candidate.key,
    url: typeof candidate.url === "string" ? candidate.url : undefined
  };
}

function parseSimulatedReply(value: unknown): SimulatedReply | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.repo !== "string" ||
    typeof candidate.pr !== "number" ||
    typeof candidate.commentId !== "string" ||
    typeof candidate.body !== "string" ||
    typeof candidate.key !== "string"
  ) {
    return undefined;
  }

  return {
    id: candidate.id,
    providerId:
      typeof candidate.providerId === "string" ? candidate.providerId : candidate.id,
    repo: candidate.repo,
    pr: candidate.pr,
    commentId: candidate.commentId,
    body: candidate.body,
    key: candidate.key
  };
}
