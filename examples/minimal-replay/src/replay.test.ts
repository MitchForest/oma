import { expect, test } from "bun:test";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import {
  MemoryWakeLock,
  defineProfile,
  defineTool,
  defineTrigger,
  validateProfile,
  routeTriggerSignal,
  spawn,
  wake
} from "@oma/core";

function testProfile(tools = ["count"]) {
  return defineProfile({
    name: "test",
    mode: "job",
    systemPrompt: "",
    skills: [],
    tools,
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: {},
    sessionKey: "review:{payload.repo}#{payload.pr}"
  });
}

test("replay reads recorded tool results instead of re-running tools", async () => {
  let executions = 0;
  const store = new MemorySessionStore();
  const profile = testProfile();
  const tools = [
    defineTool({
      name: "count",
      handler: async () => {
        executions += 1;
        return { executions };
      }
    })
  ];
  const model = new FakeModelProvider([
    { toolCalls: [{ name: "count", args: {} }] },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const secondWake = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });

  const session = await store.getSession(sessionId);

  expect(executions).toBe(1);
  expect(secondWake.status).toBe("completed");
  expect(session.events.map((event) => event.type)).toEqual([
    "session.started",
    "message.user",
    "run.started",
    "model.request",
    "model.response",
    "tool.call",
    "tool.result",
    "run.paused",
    "run.started",
    "model.request",
    "model.response",
    "run.completed"
  ]);
});

test("bounded wake pauses instead of completing unfinished work", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile();
  const tools = [
    defineTool({
      name: "count",
      handler: async () => ({ ok: true })
    })
  ];
  const model = new FakeModelProvider([{ content: "not done yet" }]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const session = await store.getSession(sessionId);

  expect(result.status).toBe("paused");
  expect(session.events.at(-1)).toMatchObject({ type: "run.paused", reason: "max-steps" });
});

test("model events include provider and bounded-context audit metadata", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile();
  const tools = [defineTool({ name: "count", handler: async () => ({ ok: true }) })];
  const model = new FakeModelProvider([{ finishReason: "done", usage: { totalTokens: 3 } }]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });

  const session = await store.getSession(sessionId);
  const request = session.events.find((event) => event.type === "model.request");
  const response = session.events.find((event) => event.type === "model.response");

  expect(request).toMatchObject({
    type: "model.request",
    provider: "fake",
    metadata: {
      profile: "test",
      mode: "job",
      toolCount: 1
    }
  });
  expect(response).toMatchObject({
    type: "model.response",
    turn: {
      finishReason: "done",
      usage: { totalTokens: 3 }
    },
    action: { type: "stop", reason: "done" }
  });
});

test("non-JSON tool results fail before appending tool result events", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile(["bad-result"]);
  const tools = [
    defineTool({
      name: "bad-result",
      handler: async () => ({ value: BigInt(1) })
    })
  ];
  const model = new FakeModelProvider([
    { toolCalls: [{ name: "bad-result", args: {} }] }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const session = await store.getSession(sessionId);

  expect(result.status).toBe("failed");
  expect(session.events.filter((event) => event.type === "tool.result")).toHaveLength(0);
  expect(session.events.at(-1)).toMatchObject({ type: "run.failed" });
});

test("unterminated external tool call retries with idempotency instead of duplicating effects", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile(["post-comment"]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });
  const externalEffects = new Map<string, { commentId: string }>();
  let executions = 0;

  await store.appendEvent(sessionId, {
    type: "tool.call",
    callId: "post-comment:1",
    toolName: "post-comment",
    args: { body: "looks risky" },
    idempotencyKey: "comment:owner/repo#42:body-hash"
  });

  externalEffects.set("comment:owner/repo#42:body-hash", { commentId: "gh-1" });

  const tools = [
    defineTool({
      name: "post-comment",
      idempotencyKey: () => "comment:owner/repo#42:body-hash",
      handler: async (_args, context) => {
        executions += 1;
        const key = context.idempotencyKey!;
        const existing = externalEffects.get(key);

        if (existing) {
          return existing;
        }

        const created = { commentId: `gh-${externalEffects.size + 1}` };
        externalEffects.set(key, created);
        return created;
      }
    })
  ];
  const model = new FakeModelProvider([{ finishReason: "done" }]);

  await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });

  expect(executions).toBe(1);
  expect(externalEffects.size).toBe(1);
  const session = await store.getSession(sessionId);
  const result = session.events.find((event) => event.type === "tool.result");
  expect(result).toMatchObject({
    type: "tool.result",
    result: { commentId: "gh-1" }
  });
});

test("tool errors fail by default and are terminal on replay", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile(["explode"]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });
  let executions = 0;
  const tools = [
    defineTool({
      name: "explode",
      handler: async () => {
        executions += 1;
        throw new Error("boom");
      }
    })
  ];
  const model = new FakeModelProvider([{ toolCalls: [{ name: "explode", args: {} }] }]);

  const first = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const second = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const session = await store.getSession(sessionId);

  expect(first.status).toBe("failed");
  expect(second.status).toBe("completed");
  expect(executions).toBe(1);
  expect(session.events.filter((event) => event.type === "tool.error")).toHaveLength(1);
  expect(session.events.filter((event) => event.type === "run.failed")).toHaveLength(1);
});

test("tool errors can continue when profile policy allows it", async () => {
  const store = new MemorySessionStore();
  const profile = defineProfile({
    ...testProfile(["explode"]),
    policy: { toolError: "continue" }
  });
  const sessionId = await spawn(store, profile, { initialMessage: "go" });
  const tools = [
    defineTool({
      name: "explode",
      handler: async () => {
        throw new Error("boom");
      }
    })
  ];
  const model = new FakeModelProvider([
    { toolCalls: [{ name: "explode", args: {} }] },
    { finishReason: "done" }
  ]);

  const result = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 2 });
  const session = await store.getSession(sessionId);

  expect(result.status).toBe("completed");
  expect(session.events.filter((event) => event.type === "tool.error")).toHaveLength(1);
  expect(session.events.at(-1)?.type).toBe("run.completed");
});

test("trigger routing uses sessionKey to spawn once and wake later", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile();
  const tools = [
    defineTool({
      name: "count",
      handler: async () => ({ ok: true })
    })
  ];
  const model = new FakeModelProvider([{ finishReason: "done" }]);
  const trigger = defineTrigger({
    on: "github:pull_request.synchronize",
    profile,
    filter: (signal) => signal.kind === "pull_request.synchronize",
    prompt: (signal) => `review ${(signal.payload as { pr: number }).pr}`
  });
  const runtime = { store, model, tools, wakeLock: new MemoryWakeLock() };

  const first = await routeTriggerSignal(runtime, trigger, {
    source: "github",
    kind: "pull_request.synchronize",
    payload: { repo: "owner/repo", pr: 42 }
  });
  const second = await routeTriggerSignal(runtime, trigger, {
    source: "github",
    kind: "pull_request.synchronize",
    payload: { repo: "owner/repo", pr: 42 }
  });

  expect(first).toEqual({ type: "spawned", sessionId: "review:owner/repo#42" });
  expect(second).toEqual({ type: "woken", sessionId: "review:owner/repo#42" });

  const session = await store.getSession("review:owner/repo#42");
  expect(session.events.filter((event) => event.type === "trigger.received")).toHaveLength(2);
  expect(session.events.map((event) => event.type).slice(0, 3)).toEqual([
    "session.started",
    "trigger.received",
    "message.user"
  ]);
});

test("trigger routing filters and rejects unresolved session keys", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile();
  const runtime = {
    store,
    model: new FakeModelProvider([{ finishReason: "done" }]),
    tools: [defineTool({ name: "count", handler: async () => ({ ok: true }) })]
  };
  const filtered = defineTrigger({
    on: "github:pull_request.synchronize",
    profile,
    filter: () => false,
    prompt: "ignored"
  });

  expect(
    await routeTriggerSignal(runtime, filtered, {
      source: "github",
      kind: "pull_request.synchronize",
      payload: { repo: "owner/repo", pr: 42 }
    })
  ).toEqual({ type: "filtered" });

  const unresolved = defineTrigger({
    on: "github:pull_request.synchronize",
    profile: defineProfile({ ...profile, sessionKey: "review:{payload.missing}" }),
    prompt: "review"
  });

  await expect(
    routeTriggerSignal(runtime, unresolved, {
      source: "github",
      kind: "pull_request.synchronize",
      payload: { repo: "owner/repo", pr: 42 }
    })
  ).rejects.toThrow("Unable to resolve sessionKey field");
});

test("concurrent first trigger routing for one key creates one session and wakes twice", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile();
  const runtime = {
    store,
    model: new FakeModelProvider([{ finishReason: "done" }]),
    tools: [defineTool({ name: "count", handler: async () => ({ ok: true }) })],
    wakeLock: new MemoryWakeLock()
  };
  const trigger = defineTrigger({
    on: "github:pull_request.synchronize",
    profile,
    prompt: "review"
  });
  const signal = {
    source: "github",
    kind: "pull_request.synchronize",
    payload: { repo: "owner/repo", pr: 43 }
  };

  const results = await Promise.all([
    routeTriggerSignal(runtime, trigger, signal),
    routeTriggerSignal(runtime, trigger, signal)
  ]);
  const session = await store.getSession("review:owner/repo#43");

  expect(results.map((result) => result.type).sort()).toEqual(["spawned", "woken"]);
  expect(session.events.filter((event) => event.type === "session.started")).toHaveLength(1);
  expect(session.events.filter((event) => event.type === "trigger.received")).toHaveLength(2);
});

test("profile and runtime validation fail early", async () => {
  expect(() =>
    validateProfile({
      ...testProfile(),
      mode: "bad"
    } as never)
  ).toThrow();

  const store = new MemorySessionStore();
  const profile = testProfile(["missing"]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });
  const model = new FakeModelProvider([{ finishReason: "done" }]);

  await expect(wake({ store, model, tools: [] }, sessionId, profile)).rejects.toThrow(
    'Profile "test" references missing tool: missing'
  );
});

test("model-requested undeclared tools fail clearly", async () => {
  const store = new MemorySessionStore();
  const profile = testProfile(["count"]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });
  const tools = [
    defineTool({ name: "count", handler: async () => ({ ok: true }) }),
    defineTool({ name: "other", handler: async () => ({ ok: true }) })
  ];
  const model = new FakeModelProvider([{ toolCalls: [{ name: "other", args: {} }] }]);

  const result = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const session = await store.getSession(sessionId);

  expect(result.status).toBe("failed");
  expect(session.events.at(-1)).toMatchObject({ type: "run.failed" });
});

test("memory wake lock serializes concurrent work for one session", async () => {
  const lock = new MemoryWakeLock();
  const order: string[] = [];

  await Promise.all([
    lock.withSessionLock("session", async () => {
      order.push("a:start");
      await Promise.resolve();
      order.push("a:end");
    }),
    lock.withSessionLock("session", async () => {
      order.push("b:start");
      order.push("b:end");
    })
  ]);

  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
});
