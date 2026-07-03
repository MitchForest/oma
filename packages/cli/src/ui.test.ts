import { afterEach, expect, test } from "bun:test";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import type { NewSessionEvent } from "@oma/core";
import { createUiServer, type UiServer } from "./ui";

const servers = new Set<UiServer>();

afterEach(() => {
  for (const server of servers) {
    server.stop();
  }

  servers.clear();
});

test("UI server projects sessions, actions, and PR review state", async () => {
  const store = new MemorySessionStore();
  const sessionId = "review:owner/repo#42";
  await seedPrReviewSession(store, sessionId);

  const server = createUiServer({
    store,
    port: 0,
    async sendMessage(id, message) {
      await store.appendEvent(id, { type: "message.user", content: message });
      return { sent: true };
    },
    async wakeSession(id) {
      await store.appendEvent(id, { type: "system.note", message: "woken" });
      return { status: "completed" };
    },
    async forkSession(id, atOffset) {
      // Mirrors the CLI fork paths: record fork provenance in metadata so the
      // session list can render badges without reading event logs.
      const source = await store.getSession(id);
      return store.fork(id, atOffset, {
        metadata: { ...source.metadata, forkedFrom: { sessionId: id, atOffset } }
      });
    }
  });
  servers.add(server);

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const sessions = await fetchJson<Array<{
    id: string;
    latestEventAt?: string;
    trigger?: { source: string; kind: string };
  }>>(`${baseUrl}/api/sessions`);
  expect(sessions.map((session) => session.id)).toContain(sessionId);
  expect(sessions.find((session) => session.id === sessionId)).toMatchObject({
    trigger: { source: "simulated-github", kind: "pull_request.opened" },
    latestEventAt: expect.any(String)
  });

  const session = await fetchJson<{
    status: string;
    view: {
      prReview: {
        repo?: string;
        pr?: number;
        status: string;
        comments: Array<{ body?: string }>;
        reviews: Array<{ body?: string }>;
        idempotency: Array<{ key?: string; status: string }>;
      };
    };
  }>(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`);
  expect(session.status).toBe("completed");
  expect(session.view.prReview).toMatchObject({
    repo: "owner/repo",
    pr: 42,
    status: "submitted",
    comments: [{ body: "Prefer an explicit check here." }],
    reviews: [{ body: "Reviewed." }],
    idempotency: [
      { key: "review-key-1", status: "completed" },
      { key: "review-submit-1", status: "completed" }
    ]
  });

  const send = await postJson<{ session: { session: { events: Array<{ type: string }> } } }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/send`,
    { message: "follow up", wake: false }
  );
  expect(send.session.session.events.at(-1)).toMatchObject({ type: "message.user" });

  const fork = await postJson<{ forkId: string }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/fork`,
    { offset: 0 }
  );
  expect(fork.forkId).toBeTruthy();

  const forkedSession = await fetchJson<{ forks: Array<{ sessionId: string }> }>(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`
  );
  expect(forkedSession.forks).toEqual([
    expect.objectContaining({ sessionId: fork.forkId })
  ]);
  const listWithFork = await fetchJson<Array<{
    id: string;
    forkedFrom?: { sessionId: string; atOffset: number };
  }>>(`${baseUrl}/api/sessions`);
  expect(listWithFork.find((session) => session.id === fork.forkId)).toMatchObject({
    forkedFrom: { sessionId, atOffset: 0 }
  });

  const html = await (await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`)).text();
  expect(html).toContain("OMA Sessions");
  expect(html).toContain('data-tab="forks"');
  expect(html).toContain("Idempotency");
});

test("UI server streams appended events", async () => {
  const store = new MemorySessionStore();
  const sessionId = "session-stream";
  await store.createSession({ id: sessionId, metadata: { profilePath: "profiles/coder-interactive/profile.json" } });
  await append(store, sessionId, { type: "session.started", profileName: "coder-interactive", mode: "interactive" });

  const server = createUiServer({
    store,
    port: 0,
    async sendMessage() {
      return {};
    },
    async wakeSession() {
      return {};
    },
    async forkSession(id, atOffset) {
      return store.fork(id, atOffset);
    }
  });
  servers.add(server);

  const abort = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent(sessionId)}/stream?fromOffset=1`,
    { signal: abort.signal }
  );
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Expected a readable SSE response body");
  }

  await append(store, sessionId, { type: "message.assistant", content: "live update" });
  let text = "";

  for (let attempt = 0; attempt < 3 && !text.includes("live update"); attempt += 1) {
    const chunk = await readWithTimeout(reader, 2_000);
    text += new TextDecoder().decode(chunk.value);
  }

  abort.abort();

  expect(text).toContain("live update");
});

test("UI server maps missing sessions to 404", async () => {
  const store = new MemorySessionStore();
  const server = createUiServer({
    store,
    port: 0,
    async sendMessage() {
      return {};
    },
    async wakeSession() {
      return {};
    },
    async forkSession(id, atOffset) {
      return store.fork(id, atOffset);
    }
  });
  servers.add(server);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/sessions/${encodeURIComponent("missing-session")}`
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining("missing-session")
  });
});

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  // A regression in the SSE stream should fail the test, not hang it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`SSE stream produced no data within ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedPrReviewSession(store: MemorySessionStore, sessionId: string): Promise<void> {
  await store.createSession({
    id: sessionId,
    metadata: {
      profilePath: "profiles/pr-review/profile.json",
      // Recorded by the trigger router on spawn; the UI session list derives
      // the trigger badge from this metadata.
      trigger: "simulated-github:pull_request.opened"
    }
  });
  await append(store, sessionId, { type: "session.started", profileName: "pr-review", mode: "automation" });
  await append(store, sessionId, {
    type: "trigger.received",
    source: "simulated-github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42 },
    deliveryId: "delivery-1"
  });
  await append(store, sessionId, { type: "message.user", content: "Review owner/repo#42" });
  await append(store, sessionId, { type: "run.started", runId: "run-1" });
  await append(store, sessionId, {
    type: "tool.call",
    callId: "call-1",
    toolName: "post_inline_comment",
    args: { path: "src/app.ts", line: 12 },
    idempotencyKey: "review-key-1"
  });
  await append(store, sessionId, {
    type: "tool.result",
    callId: "call-1",
    toolName: "post_inline_comment",
    result: {
      id: "comment-1",
      providerId: "provider-comment-1",
      path: "src/app.ts",
      line: 12,
      body: "Prefer an explicit check here.",
      key: "review-key-1"
    }
  });
  await append(store, sessionId, {
    type: "tool.call",
    callId: "call-2",
    toolName: "post_review",
    args: { body: "Reviewed." },
    idempotencyKey: "review-submit-1"
  });
  await append(store, sessionId, {
    type: "tool.result",
    callId: "call-2",
    toolName: "post_review",
    result: {
      id: "review-1",
      providerId: "provider-review-1",
      repo: "owner/repo",
      pr: 42,
      body: "Reviewed.",
      key: "review-submit-1"
    }
  });
  await append(store, sessionId, { type: "run.completed", runId: "run-1", steps: 1 });
}

async function append(
  store: MemorySessionStore,
  sessionId: string,
  event: NewSessionEvent
): Promise<void> {
  await store.appendEvent(sessionId, event);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json() as Promise<T>;
}
