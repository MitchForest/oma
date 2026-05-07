import { describe, expect, test } from "bun:test";
import { GithubClient, summaryMarker } from "../src/github";
import type { ReviewCommentPlan, ReviewRequest } from "../src/types";

const request: ReviewRequest = {
  repository: {
    owner: "oma",
    name: "example",
    fullName: "oma/example",
  },
  pullRequest: {
    number: 7,
    baseSha: "",
    headSha: "",
  },
  trigger: {
    source: "issue_comment",
    command: "oma review",
    verbose: false,
  },
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
    ...init,
  });
}

describe("GitHub client", () => {
  test("fetches PR context with mocked fetch", async () => {
    const seen: string[] = [];
    const client = new GithubClient({
      token: "secret-token",
      fetch: async (url, init) => {
        const path = String(url).replace("https://api.github.com", "");
        seen.push(path);
        const accept = new Headers(init?.headers).get("accept");
        if (path === "/repos/oma/example/pulls/7" && accept === "application/vnd.github.diff") {
          return new Response("diff --git a/a.ts b/a.ts\n");
        }
        if (path === "/repos/oma/example/pulls/7") {
          return jsonResponse({
            title: "Example PR",
            body: "Body",
            user: {
              login: "mitch",
            },
            base: {
              ref: "main",
              sha: "base",
            },
            head: {
              ref: "branch",
              sha: "head",
            },
          });
        }
        if (path === "/repos/oma/example/pulls/7/files") {
          return jsonResponse([]);
        }
        if (path === "/repos/oma/example/issues/7/comments") {
          return jsonResponse([
            {
              id: 10,
              body: `${summaryMarker}\n<!-- oma-finding:existing -->`,
            },
          ]);
        }
        return jsonResponse(
          {
            message: "unexpected request",
          },
          {
            status: 404,
          },
        );
      },
    });

    const context = await client.fetchPullRequestContext(request);

    expect(context.title).toBe("Example PR");
    expect(context.request.pullRequest.headSha).toBe("head");
    expect(context.existingSummaryCommentId).toBe(10);
    expect(context.existingFindingIds).toEqual(["existing"]);
    expect(seen).toContain("/repos/oma/example/pulls/7");
    expect(seen).toContain("/repos/oma/example/pulls/7/files");
  });

  test("updates summary and publishes inline review with mocked writes", async () => {
    const writes: Array<{ method: string; path: string; body?: string }> = [];
    const plan: ReviewCommentPlan = {
      summary: {
        marker: summaryMarker,
        body: `${summaryMarker}\n\nReview body`,
      },
      ledger: {
        schemaVersion: 1,
        runNumber: 1,
        headSha: "head",
        updatedAt: "2026-05-07T00:00:00.000Z",
        findings: [],
      },
      stats: {
        newFindings: 0,
        stillOpen: 0,
        resolvedSinceLastRun: 0,
        suppressed: 0,
        inlinePosted: 1,
        totalOpen: 0,
      },
      inline: [
        {
          findingId: "finding-1",
          path: "src/app.ts",
          line: 12,
          side: "RIGHT",
          body: "Finding body",
        },
      ],
      skipped: [],
    };
    const client = new GithubClient({
      token: "secret-token",
      fetch: async (url, init) => {
        const path = String(url).replace("https://api.github.com", "");
        const method = init?.method ?? "GET";
        if (method === "GET" && path === "/repos/oma/example/issues/7/comments") {
          return jsonResponse([
            {
              id: 10,
              body: summaryMarker,
            },
          ]);
        }
        const write: { method: string; path: string; body?: string } = {
          method,
          path,
        };
        if (typeof init?.body === "string") {
          write.body = init.body;
        }
        writes.push(write);
        return jsonResponse({});
      },
    });

    await client.upsertSummary(request, plan);
    await client.publishInlineReview(request, plan);

    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "PATCH /repos/oma/example/issues/comments/10",
      "POST /repos/oma/example/pulls/7/reviews",
    ]);
    expect(writes[1]?.body).toContain("oma-finding:finding-1");
  });

  test("sets commit statuses and final reactions", async () => {
    const writes: Array<{ method: string; path: string; body?: string }> = [];
    const client = new GithubClient({
      token: "secret-token",
      fetch: async (url, init) => {
        const write: { method: string; path: string; body?: string } = {
          method: init?.method ?? "GET",
          path: String(url).replace("https://api.github.com", ""),
        };
        if (typeof init?.body === "string") {
          write.body = init.body;
        }
        writes.push(write);
        return jsonResponse({});
      },
    });

    await client.setReviewStatus(
      {
        ...request,
        pullRequest: {
          ...request.pullRequest,
          headSha: "head",
        },
      },
      {
        state: "pending",
        description: "Review in progress",
        targetUrl: "https://example.test/run",
      },
    );
    await client.addReaction(request, 42, "+1");

    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      "POST /repos/oma/example/statuses/head",
      "POST /repos/oma/example/issues/comments/42/reactions",
    ]);
    expect(writes[0]?.body).toContain('"context":"OMA PR Review"');
    expect(writes[1]?.body).toContain('"+1"');
  });
});
