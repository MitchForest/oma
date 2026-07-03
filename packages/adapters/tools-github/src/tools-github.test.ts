import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createGitHubTools, githubToolNames } from "./index";

test("GitHub tools post inline comments with provider metadata", async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === "GET") {
        requests.push({ method: request.method, path: url.pathname, body: undefined });
        return Response.json([]);
      }

      requests.push({
        method: request.method,
        path: url.pathname,
        body: await request.json()
      });

      return Response.json({
        id: 123,
        html_url: "https://github.test/comment/123",
        body: "Use the existing helper."
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "post_inline_comment");

    expect(tool?.idempotencyKey?.(
      {
        key: "owner/repo#1:src/app.ts:12:issue",
        repo: "owner/repo",
        pr: 1,
        commitId: "abc123",
        path: "src/app.ts",
        line: 12,
        body: "Use the existing helper."
      },
      { sessionId: "session-a", callId: "call-a" }
    )).toBe("owner/repo#1:src/app.ts:12:issue");

    const result = await tool?.handler(
      {
        key: "owner/repo#1:src/app.ts:12:issue",
        repo: "owner/repo",
        pr: 1,
        commitId: "abc123",
        path: "src/app.ts",
        line: 12,
        body: "Use the existing helper."
      },
      { sessionId: "session-a", callId: "call-a" }
    );

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/repos/owner/repo/pulls/1/comments",
        body: undefined
      },
      {
        method: "POST",
        path: "/repos/owner/repo/pulls/1/comments",
        body: {
          body: expect.stringContaining("Use the existing helper."),
          commit_id: "abc123",
          path: "src/app.ts",
          line: 12,
          side: "RIGHT"
        }
      }
    ]);
    expect((requests[1]?.body as { body: string }).body).toContain("<!-- oma:idempotency:");
    expect(result).toMatchObject({
      key: "owner/repo#1:src/app.ts:12:issue",
      provider: "github",
      providerId: "123",
      url: "https://github.test/comment/123"
    });
  } finally {
    server.stop(true);
  }
});

test("GitHub mutation tools recover existing provider-side comments before posting", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  let existingBody = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });

      if (request.method === "GET") {
        return Response.json([
          {
            id: 123,
            html_url: "https://github.test/comment/123",
            body: existingBody
          }
        ]);
      }

      const body = (await request.json()) as { body: string };
      return Response.json({
        id: 999,
        html_url: "https://github.test/comment/999",
        body: body.body
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "post_inline_comment")!;
    const args = {
      key: "owner/repo#1:src/app.ts:12:issue",
      repo: "owner/repo",
      pr: 1,
      commitId: "abc123",
      path: "src/app.ts",
      line: 12,
      body: "Use the existing helper."
    };
    const first = await tool.handler(args, { sessionId: "session-a", callId: "call-a" });

    existingBody = (first as { body: string }).body;
    requests.length = 0;

    const second = await tool.handler(args, { sessionId: "session-a", callId: "call-a" });

    expect(requests).toEqual([
      { method: "GET", path: "/repos/owner/repo/pulls/1/comments" }
    ]);
    expect(second).toMatchObject({
      providerId: "123",
      url: "https://github.test/comment/123"
    });
  } finally {
    server.stop(true);
  }
});

test("GitHub tools fetch PR diffs as text", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => new Response("diff --git a/a b/a")
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "get_diff");

    expect(
      await tool?.handler(
        { repo: "owner/repo", pr: 1 },
        { sessionId: "session-a", callId: "call-a" }
      )
    ).toEqual({ diff: "diff --git a/a b/a" });
  } finally {
    server.stop(true);
  }
});

test("GitHub tool schemas reject path-injection in repo, ids, refs, and file paths", () => {
  const tools = createGitHubTools({ token: "test-token" });
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;

  // repo must be exactly owner/name with safe characters.
  for (const repo of [
    "owner/repo/extra",
    "owner",
    "owner/repo?x=1",
    "owner/..",
    "../repo",
    "owner/repo#1",
    "owner /repo"
  ]) {
    expect(() => tool("get_pr_metadata").schema!.parse({ repo, pr: 1 })).toThrow();
  }
  expect(() =>
    tool("get_pr_metadata").schema!.parse({ repo: "owner-1/repo.name_x", pr: 1 })
  ).not.toThrow();

  // numeric ids only.
  expect(() =>
    tool("reply_to_comment").schema!.parse({
      repo: "owner/repo",
      pr: 1,
      commentId: "123/../../issues",
      body: "x"
    })
  ).toThrow();
  expect(() =>
    tool("get_ci_logs").schema!.parse({ repo: "owner/repo", jobId: "9/logs?x=1" })
  ).toThrow();
  expect(() =>
    tool("get_ci_logs").schema!.parse({ repo: "owner/repo", jobId: "987654321" })
  ).not.toThrow();

  // refs and file paths must not traverse.
  expect(() => tool("get_ci_status").schema!.parse({ repo: "owner/repo", ref: ".." })).toThrow();
  expect(() =>
    tool("get_file_at_ref").schema!.parse({
      repo: "owner/repo",
      path: "../secrets.env",
      ref: "main"
    })
  ).toThrow();
  expect(() =>
    tool("get_file_at_ref").schema!.parse({
      repo: "owner/repo",
      path: "src/app.ts",
      ref: "feature/x"
    })
  ).not.toThrow();
});

test("GitHub tools build request paths from encoded segments", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      return Response.json({});
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "get_ci_status")!;

    await tool.handler(
      { repo: "owner/repo", ref: "feature/x" },
      { sessionId: "session-a", callId: "call-a" }
    );

    expect(paths).toEqual(["/repos/owner/repo/commits/feature%2Fx/check-runs"]);
  } finally {
    server.stop(true);
  }
});

test("idempotency markers embed a sha256 of the key, not the key itself", async () => {
  let postedBody = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") {
        return Response.json([]);
      }

      postedBody = ((await request.json()) as { body: string }).body;
      return Response.json({ id: 1, body: postedBody });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "post_inline_comment")!;
    const key = "owner/repo#1:src/app.ts:12:issue";

    const result = await tool.handler(
      {
        key,
        repo: "owner/repo",
        pr: 1,
        commitId: "abc123",
        path: "src/app.ts",
        line: 12,
        body: "Short body."
      },
      { sessionId: "session-a", callId: "call-a" }
    );

    const expectedHash = createHash("sha256").update(key).digest("hex");
    expect(postedBody).toBe(`Short body.\n\n<!-- oma:idempotency:${expectedHash} -->`);
    // The full human-readable key stays in the recorded metadata.
    expect(result).toMatchObject({ key, provider: "github" });
    // The raw key never appears in the posted body.
    expect(postedBody).not.toContain(key);
  } finally {
    server.stop(true);
  }
});

test("idempotency recovery follows Link pagination to later pages", async () => {
  const key = "owner/repo#1:src/app.ts:12:issue";
  const markerHash = createHash("sha256").update(key).digest("hex");
  const requests: Array<{ method: string; page: string | null; perPage: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        page: url.searchParams.get("page"),
        perPage: url.searchParams.get("per_page")
      });

      if (request.method !== "GET") {
        throw new Error("recovery must not POST when the marker exists");
      }

      if (url.searchParams.get("page") === "2") {
        return Response.json([
          {
            id: 77,
            html_url: "https://github.test/comment/77",
            body: `Posted earlier.\n\n<!-- oma:idempotency:${markerHash} -->`
          }
        ]);
      }

      return Response.json([{ id: 1, body: "unrelated" }], {
        headers: {
          link: `<http://${url.host}${url.pathname}?per_page=100&page=2>; rel="next"`
        }
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "post_inline_comment")!;

    const result = await tool.handler(
      {
        key,
        repo: "owner/repo",
        pr: 1,
        commitId: "abc123",
        path: "src/app.ts",
        line: 12,
        body: "Posted earlier."
      },
      { sessionId: "session-a", callId: "call-a" }
    );

    expect(requests).toEqual([
      { method: "GET", page: null, perPage: "100" },
      { method: "GET", page: "2", perPage: "100" }
    ]);
    expect(result).toMatchObject({ providerId: "77", key });
  } finally {
    server.stop(true);
  }
});

test("idempotency recovery fails closed when the page cap is hit", async () => {
  let gets = 0;
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        posts += 1;
        return Response.json({ id: 1 });
      }

      gets += 1;
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json([{ id: page, body: "unrelated" }], {
        headers: {
          link: `<http://${url.host}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"`
        }
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "post_inline_comment")!;

    await expect(
      tool.handler(
        {
          key: "owner/repo#1:src/app.ts:12:issue",
          repo: "owner/repo",
          pr: 1,
          commitId: "abc123",
          path: "src/app.ts",
          line: 12,
          body: "Body."
        },
        { sessionId: "session-a", callId: "call-a" }
      )
    ).rejects.toThrow(/refusing to post/);
    expect(gets).toBe(10);
    expect(posts).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("resolve_thread issues the GraphQL resolveReviewThread mutation", async () => {
  const graphqlRequests: Array<{ path: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      graphqlRequests.push({ path: url.pathname, body: await request.json() });

      return Response.json({
        data: {
          resolveReviewThread: {
            thread: { id: "PRRT_node123", isResolved: true }
          }
        }
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "resolve_thread")!;

    const result = await tool.handler(
      { threadId: "PRRT_node123" },
      { sessionId: "session-a", callId: "call-a" }
    );

    expect(graphqlRequests).toHaveLength(1);
    expect(graphqlRequests[0]?.path).toBe("/graphql");
    expect(graphqlRequests[0]?.body.query).toContain("resolveReviewThread");
    expect(graphqlRequests[0]?.body.variables).toEqual({ threadId: "PRRT_node123" });
    expect(result).toEqual({
      id: "PRRT_node123",
      key: "PRRT_node123:resolve",
      provider: "github",
      providerId: "PRRT_node123",
      resolved: true
    });
  } finally {
    server.stop(true);
  }
});

test("resolve_thread honors an explicit graphqlUrl override", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      return Response.json({
        data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } }
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: "http://127.0.0.1:9", // unreachable on purpose — must not be used
      graphqlUrl: `http://127.0.0.1:${server.port}/api/graphql`
    });
    const tool = tools.find((candidate) => candidate.name === "resolve_thread")!;

    await tool.handler({ threadId: "T1" }, { sessionId: "s", callId: "c" });

    expect(paths).toEqual(["/api/graphql"]);
  } finally {
    server.stop(true);
  }
});

test("resolve_thread throws on GraphQL errors", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () =>
      Response.json({
        data: null,
        errors: [{ message: "Could not resolve to a node with the global id" }]
      })
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`
    });
    const tool = tools.find((candidate) => candidate.name === "resolve_thread")!;

    await expect(
      tool.handler({ threadId: "bogus" }, { sessionId: "s", callId: "c" })
    ).rejects.toThrow(/Could not resolve to a node/);
  } finally {
    server.stop(true);
  }
});

test("get_ci_logs fetches per-job logs and truncates to the byte cap", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      return new Response("x".repeat(5000), {
        headers: { "content-type": "text/plain" }
      });
    }
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
      maxLogBytes: 1000
    });
    const tool = tools.find((candidate) => candidate.name === "get_ci_logs")!;

    const result = (await tool.handler(
      { repo: "owner/repo", jobId: "42" },
      { sessionId: "s", callId: "c" }
    )) as { logs: string; truncated: boolean };

    expect(paths).toEqual(["/repos/owner/repo/actions/jobs/42/logs"]);
    expect(result.truncated).toBe(true);
    expect(result.logs).toBe("x".repeat(1000));
  } finally {
    server.stop(true);
  }
});

test("get_ci_logs reports truncated=false when logs fit the cap", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => new Response("short log", { headers: { "content-type": "text/plain" } })
  });

  try {
    const tools = createGitHubTools({
      token: "test-token",
      baseUrl: `http://127.0.0.1:${server.port}`,
      maxLogBytes: 1000
    });
    const tool = tools.find((candidate) => candidate.name === "get_ci_logs")!;

    expect(
      await tool.handler({ repo: "owner/repo", jobId: "42" }, { sessionId: "s", callId: "c" })
    ).toEqual({ logs: "short log", truncated: false });
  } finally {
    server.stop(true);
  }
});

test("githubToolNames stays in sync with the constructed tool set", () => {
  const tools = createGitHubTools({ token: "unused" });

  expect(tools.map((tool) => tool.name).sort()).toEqual([...githubToolNames].sort());
});
