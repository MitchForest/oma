import { defineTool, type AnyTool } from "@oma/core";
import { createHash } from "node:crypto";
import { z } from "zod";

export interface GitHubToolsOptions {
  token: string;
  baseUrl?: string;
  /**
   * GraphQL endpoint used by `resolve_thread`. Defaults to `${baseUrl}/graphql`
   * (correct for api.github.com; override for GitHub Enterprise or tests).
   */
  graphqlUrl?: string;
  userAgent?: string;
  /** Byte cap applied to `get_ci_logs` output. Defaults to 65536. */
  maxLogBytes?: number;
}

const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

/** Idempotency recovery never scans more than this many pages (per_page=100). */
const MAX_RECOVERY_PAGES = 10;

const repoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like "owner/name"')
  .refine(
    (value) => value.split("/").every((segment) => segment !== "." && segment !== ".."),
    { message: 'repo segments must not be "." or ".."' }
  );

const numericIdSchema = z.string().regex(/^\d+$/, "id must be a decimal number");

const refSchema = z
  .string()
  .min(1)
  .refine((value) => value !== "." && value !== "..", {
    message: 'ref must not be "." or ".."'
  });

const filePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: 'path segments must not be empty, "." or ".."' }
  );

const repoPrSchema = z.object({
  repo: repoSchema,
  pr: z.number().int().positive()
});

const repoRefSchema = z.object({
  repo: repoSchema,
  ref: refSchema
});

/**
 * Tool names this adapter provides, for wiring decisions (e.g. "does this
 * profile need a GitHub token?") without constructing a client.
 */
export const githubToolNames = [
  "get_pr_metadata",
  "get_diff",
  "get_file_at_ref",
  "get_prior_comments",
  "get_review_threads",
  "get_ci_status",
  "get_ci_logs",
  "post_inline_comment",
  "post_review",
  "reply_to_comment",
  "resolve_thread"
] as const;

export function createGitHubTools(options: GitHubToolsOptions): AnyTool[] {
  const client = new GitHubClient(options);
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

  return [
    defineTool({
      name: "get_pr_metadata",
      description: "Fetch GitHub pull request metadata.",
      effect: "read",
      capabilities: ["github.pr.metadata"],
      schema: repoPrSchema,
      handler: async ({ repo, pr }) =>
        client.request("GET", repoPath(repo, "pulls", String(pr)))
    }),
    defineTool({
      name: "get_diff",
      description: "Fetch a GitHub pull request diff.",
      effect: "read",
      capabilities: ["github.pr.diff"],
      schema: repoPrSchema,
      handler: async ({ repo, pr }) => ({
        diff: await client.text("GET", repoPath(repo, "pulls", String(pr)), {
          accept: "application/vnd.github.v3.diff"
        })
      })
    }),
    defineTool({
      name: "get_file_at_ref",
      description: "Fetch file content at a repository ref.",
      effect: "read",
      capabilities: ["github.file.read"],
      schema: z.object({
        repo: repoSchema,
        path: filePathSchema,
        ref: refSchema
      }),
      handler: async ({ repo, path, ref }) =>
        client.request(
          "GET",
          `${repoPath(repo, "contents")}/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
        )
    }),
    defineTool({
      name: "get_prior_comments",
      description: "Fetch pull request review comments.",
      effect: "read",
      capabilities: ["github.comment.list"],
      schema: repoPrSchema,
      handler: async ({ repo, pr }) =>
        client.request("GET", repoPath(repo, "pulls", String(pr), "comments"))
    }),
    defineTool({
      name: "get_review_threads",
      description: "Fetch pull request review comments grouped as review-thread inputs.",
      effect: "read",
      capabilities: ["github.thread.list"],
      schema: repoPrSchema,
      handler: async ({ repo, pr }) => ({
        comments: await client.request(
          "GET",
          repoPath(repo, "pulls", String(pr), "comments")
        )
      })
    }),
    defineTool({
      name: "get_ci_status",
      description: "Fetch check runs for a ref.",
      effect: "read",
      capabilities: ["github.ci.status"],
      schema: repoRefSchema,
      handler: async ({ repo, ref }) =>
        client.request(
          "GET",
          repoPath(repo, "commits", ref, "check-runs")
        )
    }),
    defineTool({
      name: "get_ci_logs",
      description:
        "Fetch plain-text logs for a single workflow job, truncated to a byte cap.",
      effect: "read",
      capabilities: ["github.ci.logs"],
      schema: z.object({
        repo: repoSchema,
        jobId: numericIdSchema
      }),
      handler: async ({ repo, jobId }) => {
        const { text, truncated } = await client.cappedText(
          "GET",
          repoPath(repo, "actions", "jobs", jobId, "logs"),
          maxLogBytes
        );

        return { logs: text, truncated };
      }
    }),
    defineTool({
      name: "post_inline_comment",
      description: "Post an inline pull request review comment.",
      effect: "external",
      capabilities: ["github.comment.write"],
      schema: z.object({
        key: z.string().min(1),
        repo: repoSchema,
        pr: z.number().int().positive(),
        commitId: z.string().min(1),
        path: filePathSchema,
        line: z.number().int().positive(),
        body: z.string().min(1)
      }),
      idempotencyKey: ({ key }) => key,
      handler: async ({ key, repo, pr, commitId, path, line, body }) => {
        const marker = idempotencyMarker(key);
        const existing = await client.findReviewComment(repo, pr, marker);

        if (existing) {
          return withProviderMetadata(existing, key);
        }

        const created = await client.request(
          "POST",
          repoPath(repo, "pulls", String(pr), "comments"),
          {
            body: {
              body: withIdempotencyMarker(body, key),
              commit_id: commitId,
              path,
              line,
              side: "RIGHT"
            }
          }
        );

        return withProviderMetadata(created, key);
      }
    }),
    defineTool({
      name: "post_review",
      description: "Post a pull request review summary.",
      effect: "external",
      capabilities: ["github.review.write"],
      schema: z.object({
        repo: repoSchema,
        pr: z.number().int().positive(),
        body: z.string().min(1),
        event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]).default("COMMENT")
      }),
      idempotencyKey: ({ repo, pr, body, event }) => `${repo}#${pr}:review:${event}:${body}`,
      handler: async ({ repo, pr, body, event }) => {
        const key = `${repo}#${pr}:review:${event}:${body}`;
        const marker = idempotencyMarker(key);
        const existing = await client.findReview(repo, pr, marker);

        if (existing) {
          return withProviderMetadata(existing, key);
        }

        const created = await client.request(
          "POST",
          repoPath(repo, "pulls", String(pr), "reviews"),
          { body: { body: withIdempotencyMarker(body, key), event } }
        );

        return withProviderMetadata(created, key);
      }
    }),
    defineTool({
      name: "reply_to_comment",
      description: "Reply to an existing GitHub review comment.",
      effect: "external",
      capabilities: ["github.comment.write"],
      schema: z.object({
        repo: repoSchema,
        pr: z.number().int().positive(),
        commentId: numericIdSchema,
        body: z.string().min(1)
      }),
      idempotencyKey: ({ repo, pr, commentId, body }) =>
        `${repo}#${pr}:comment:${commentId}:reply:${body}`,
      handler: async ({ repo, pr, commentId, body }) => {
        const key = `${repo}#${pr}:comment:${commentId}:reply:${body}`;
        const marker = idempotencyMarker(key);
        const existing = await client.findReviewComment(repo, pr, marker);

        if (existing) {
          return withProviderMetadata(existing, key);
        }

        const created = await client.request(
          "POST",
          repoPath(repo, "pulls", String(pr), "comments", commentId, "replies"),
          { body: { body: withIdempotencyMarker(body, key) } }
        );

        return withProviderMetadata(created, key);
      }
    }),
    defineTool({
      name: "resolve_thread",
      description: "Resolve a pull request review thread (GraphQL node id).",
      effect: "external",
      capabilities: ["github.thread.resolve"],
      schema: z.object({
        threadId: z.string().min(1)
      }),
      idempotencyKey: ({ threadId }) => `${threadId}:resolve`,
      handler: async ({ threadId }) => {
        const key = `${threadId}:resolve`;
        const data = await client.graphql(
          "mutation ResolveReviewThread($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
          { threadId }
        );
        const thread = extractResolvedThread(data);

        return {
          id: thread.id,
          key,
          provider: "github",
          providerId: thread.id,
          resolved: thread.isResolved
        };
      }
    })
  ];
}

class GitHubClient {
  private readonly baseUrl: string;
  private readonly graphqlUrl: string;

  constructor(private readonly options: GitHubToolsOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.graphqlUrl = options.graphqlUrl ?? `${this.baseUrl}/graphql`;
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; accept?: string } = {}
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(options.accept),
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }

  async text(
    method: string,
    path: string,
    options: { accept?: string } = {}
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(options.accept)
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
    }

    return response.text();
  }

  async cappedText(
    method: string,
    path: string,
    capBytes: number
  ): Promise<{ text: string; truncated: boolean }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers()
    });

    if (!response.ok) {
      throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
    }

    if (!response.body) {
      return { text: "", truncated: false };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      const remaining = capBytes - received;

      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        received = capBytes;
        // Truncated if this chunk overflowed the cap, or if it filled the cap
        // exactly and more data was still pending.
        truncated = value.byteLength > remaining || !(await reader.read()).done;
        await reader.cancel().catch(() => {});
        break;
      }

      chunks.push(value);
      received += value.byteLength;
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(concatBytes(chunks, received));
    return { text, truncated };
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(this.graphqlUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      throw new Error(
        `GitHub GraphQL request failed: ${response.status} ${await response.text()}`
      );
    }

    const payload = (await response.json()) as {
      data?: unknown;
      errors?: Array<{ message?: unknown }>;
    };

    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors
        .map((error) => (typeof error?.message === "string" ? error.message : "unknown error"))
        .join("; ");
      throw new Error(`GitHub GraphQL error: ${messages}`);
    }

    if (!payload.data || typeof payload.data !== "object") {
      throw new Error("GitHub GraphQL response is missing data");
    }

    return payload.data;
  }

  async findReviewComment(repo: string, pr: number, marker: string): Promise<unknown | undefined> {
    return this.findMarkedItemPaginated(repoPath(repo, "pulls", String(pr), "comments"), marker);
  }

  async findReview(repo: string, pr: number, marker: string): Promise<unknown | undefined> {
    return this.findMarkedItemPaginated(repoPath(repo, "pulls", String(pr), "reviews"), marker);
  }

  /**
   * Scan listing pages (per_page=100, following Link rel="next") for the
   * idempotency marker. Fails closed: if the page cap is reached before the
   * listing is exhausted, throw rather than risk reposting a duplicate.
   */
  private async findMarkedItemPaginated(
    path: string,
    marker: string
  ): Promise<unknown | undefined> {
    let url = `${this.baseUrl}${path}?per_page=100`;

    for (let page = 1; page <= MAX_RECOVERY_PAGES; page += 1) {
      const response = await fetch(url, { method: "GET", headers: this.headers() });

      if (!response.ok) {
        throw new Error(`GitHub request failed: ${response.status} ${await response.text()}`);
      }

      const items = await response.json();
      const found = findMarkedItem(items, marker);

      if (found) {
        return found;
      }

      const next = parseNextLink(response.headers.get("link"));

      if (!next) {
        return undefined;
      }

      url = next;
    }

    throw new Error(
      `GitHub idempotency recovery exhausted ${MAX_RECOVERY_PAGES} pages of ${path} ` +
        "without reaching the end of the listing; refusing to post (could duplicate)."
    );
  }

  private headers(accept?: string): Record<string, string> {
    return {
      accept: accept ?? "application/vnd.github+json",
      authorization: `Bearer ${this.options.token}`,
      "content-type": "application/json",
      "user-agent": this.options.userAgent ?? "oma"
    };
  }
}

function repoPath(repo: string, ...segments: string[]): string {
  const [owner, name] = repo.split("/");

  return [
    "/repos",
    encodeURIComponent(owner ?? ""),
    encodeURIComponent(name ?? ""),
    ...segments.map(encodeURIComponent)
  ].join("/");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function parseNextLink(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

function extractResolvedThread(data: unknown): { id: string; isResolved: boolean } {
  const mutation =
    data && typeof data === "object"
      ? (data as Record<string, unknown>).resolveReviewThread
      : undefined;
  const thread =
    mutation && typeof mutation === "object"
      ? (mutation as Record<string, unknown>).thread
      : undefined;

  if (!thread || typeof thread !== "object") {
    throw new Error("GitHub GraphQL resolveReviewThread returned no thread");
  }

  const record = thread as Record<string, unknown>;

  if (typeof record.id !== "string") {
    throw new Error("GitHub GraphQL resolveReviewThread returned a thread without an id");
  }

  return { id: record.id, isResolved: record.isResolved === true };
}

function withProviderMetadata(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return { key, provider: "github", value };
  }

  const record = value as Record<string, unknown>;
  const providerId = String(record.id ?? record.node_id ?? key);

  return {
    ...record,
    key,
    provider: "github",
    providerId,
    url:
      typeof record.html_url === "string"
        ? record.html_url
        : typeof record.url === "string"
          ? record.url
          : undefined
  };
}

function withIdempotencyMarker(body: string, key: string): string {
  return `${body}\n\n${idempotencyMarker(key)}`;
}

/**
 * The marker embeds a sha256 of the idempotency key (not the key itself) so
 * long keys — which include the full body — never bloat the posted comment.
 * The human-readable key is still recorded in the tool result metadata.
 */
function idempotencyMarker(key: string): string {
  return `<!-- oma:idempotency:${hashMarkerKey(key)} -->`;
}

function hashMarkerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function findMarkedItem(value: unknown, marker: string): unknown | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const body = (item as { body?: unknown }).body;
    return typeof body === "string" && body.includes(marker);
  });
}
