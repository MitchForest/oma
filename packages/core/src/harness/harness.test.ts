import { expect, test } from "bun:test";

import { spawn } from "../entities/entities";
import type { ModelProvider, ModelTurn } from "../model/provider";
import { defineProfile, type Profile } from "../profiles/profile";
import { sessionEventSchema, type SessionEvent } from "../session/events";
import type { SessionStore } from "../session/store";
import { defineTool } from "../tools/tool";
import { wake } from "./harness";

// A deliberately tiny in-memory store: core tests must not depend on adapter
// packages. The real reference implementation lives in adapter-session-memory.
function memoryStore(): SessionStore {
  const sessions = new Map<string, SessionEvent[]>();

  const require = (sessionId: string): SessionEvent[] => {
    const events = sessions.get(sessionId);

    if (!events) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return events;
  };

  return {
    createSession: async (options) => {
      const id = options?.id ?? crypto.randomUUID();
      sessions.set(id, []);
      return id;
    },
    exists: async (sessionId) => sessions.has(sessionId),
    appendEvent: async (sessionId, event) => {
      const events = require(sessionId);
      const stored = sessionEventSchema.parse({
        ...event,
        id: crypto.randomUUID(),
        sessionId,
        offset: events.length,
        createdAt: new Date().toISOString()
      });
      events.push(stored);
      return stored;
    },
    getSession: async (sessionId, options) => ({
      id: sessionId,
      events: require(sessionId).filter((event) => event.offset >= (options?.fromOffset ?? 0))
    }),
    subscribe: () => {
      throw new Error("not used in harness tests");
    },
    fork: () => {
      throw new Error("not used in harness tests");
    }
  };
}

function testProfile(tools: string[], policy: Record<string, unknown> = {}): Profile {
  return defineProfile({
    name: "harness-test",
    mode: "job",
    systemPrompt: "test",
    skills: [],
    tools,
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy
  });
}

function scriptedModel(turns: ModelTurn[]): ModelProvider {
  let index = 0;

  return {
    info: { provider: "scripted" },
    turn: async () => turns[Math.min(index++, turns.length - 1)] ?? { finishReason: "done" }
  };
}

test("a turn with assistant text and multiple tool calls records all of them in order", async () => {
  const store = memoryStore();
  const profile = testProfile(["alpha", "beta"]);
  const executed: string[] = [];
  const tools = [
    defineTool({ name: "alpha", handler: async () => executed.push("alpha") }),
    defineTool({ name: "beta", handler: async () => executed.push("beta") })
  ];
  const model = scriptedModel([
    {
      content: "Running both checks.",
      toolCalls: [
        { id: "call-1", name: "alpha", args: {} },
        { id: "call-2", name: "beta", args: {} }
      ]
    },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile);

  expect(result.status).toBe("completed");
  expect(executed).toEqual(["alpha", "beta"]);

  const types = result.events.map((event) => event.type);
  const assistantIndex = types.indexOf("message.assistant");
  const firstCallIndex = types.indexOf("tool.call");

  expect(assistantIndex).toBeGreaterThan(-1);
  expect(assistantIndex).toBeLessThan(firstCallIndex);
  expect(types.filter((type) => type === "tool.call")).toHaveLength(2);
  expect(types.filter((type) => type === "tool.result")).toHaveLength(2);
});

test("a model that legitimately repeats a call without provider ids gets a fresh execution", async () => {
  const store = memoryStore();
  const profile = testProfile(["count"]);
  let executions = 0;
  const tools = [defineTool({ name: "count", handler: async () => ({ executions: ++executions }) })];
  const model = scriptedModel([
    { toolCalls: [{ name: "count", args: {} }] },
    { toolCalls: [{ name: "count", args: {} }] },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile);

  expect(result.status).toBe("completed");
  expect(executions).toBe(2);

  const callIds = result.events.flatMap((event) =>
    event.type === "tool.call" ? [event.callId] : []
  );
  expect(new Set(callIds).size).toBe(2);
});

test("a re-emitted provider call id replays the recorded terminal instead of re-executing", async () => {
  const store = memoryStore();
  const profile = testProfile(["count"]);
  let executions = 0;
  const tools = [defineTool({ name: "count", handler: async () => ({ executions: ++executions }) })];
  const model = scriptedModel([
    { toolCalls: [{ id: "fixed-id", name: "count", args: {} }] },
    { toolCalls: [{ id: "fixed-id", name: "count", args: {} }] },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile);

  expect(result.status).toBe("completed");
  expect(executions).toBe(1);
  expect(result.events.filter((event) => event.type === "tool.call")).toHaveLength(1);
});

test("a crash partway through a multi-call turn resumes the un-started calls on wake", async () => {
  const store = memoryStore();
  const profile = testProfile(["alpha", "beta", "gamma"]);
  const executed: string[] = [];
  const tools = [
    defineTool({ name: "alpha", handler: async () => executed.push("alpha") }),
    defineTool({ name: "beta", handler: async () => executed.push("beta") }),
    defineTool({ name: "gamma", handler: async () => executed.push("gamma") })
  ];
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  // Simulate a crash after the turn was recorded and alpha/beta completed but
  // gamma never started: model.response carries all three assigned calls.
  await store.appendEvent(sessionId, { type: "run.started", runId: "crashed-run" });
  await store.appendEvent(sessionId, {
    type: "model.response",
    turn: { finishReason: "tool_use" },
    action: {
      type: "tool",
      calls: [
        { toolName: "alpha", args: {}, callId: "call-a" },
        { toolName: "beta", args: {}, callId: "call-b" },
        { toolName: "gamma", args: {}, callId: "call-c" }
      ]
    }
  });
  await store.appendEvent(sessionId, {
    type: "tool.call",
    callId: "call-a",
    toolName: "alpha",
    args: {}
  });
  await store.appendEvent(sessionId, {
    type: "tool.result",
    callId: "call-a",
    toolName: "alpha",
    result: 1
  });
  await store.appendEvent(sessionId, {
    type: "tool.call",
    callId: "call-b",
    toolName: "beta",
    args: {}
  });
  await store.appendEvent(sessionId, {
    type: "tool.result",
    callId: "call-b",
    toolName: "beta",
    result: 2
  });

  const model = scriptedModel([{ finishReason: "done" }]);
  const result = await wake({ store, model, tools }, sessionId, profile);

  expect(result.status).toBe("completed");
  // alpha and beta were recorded as done; only gamma runs on recovery.
  expect(executed).toEqual(["gamma"]);

  const calls = result.events.filter((event) => event.type === "tool.call");
  const results = result.events.filter((event) => event.type === "tool.result");
  expect(calls).toHaveLength(3);
  expect(results).toHaveLength(3);
});

test("a model failure appends model.error before the run fails", async () => {
  const store = memoryStore();
  const profile = testProfile([]);
  const model: ModelProvider = {
    info: { provider: "broken" },
    turn: async () => {
      throw new Error("provider unreachable");
    }
  };
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools: [] }, sessionId, profile);

  expect(result.status).toBe("failed");
  const types = result.events.map((event) => event.type);
  expect(types.indexOf("model.error")).toBeGreaterThan(-1);
  expect(types.indexOf("model.error")).toBeLessThan(types.indexOf("run.failed"));
});

test("wake honors profile.policy.maxSteps when no override is given", async () => {
  const store = memoryStore();
  const profile = testProfile(["count"], { maxSteps: 1 });
  const tools = [defineTool({ name: "count", handler: async () => ({}) })];
  const model = scriptedModel([
    { toolCalls: [{ name: "count", args: {} }] },
    { toolCalls: [{ name: "count", args: {} }] },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools }, sessionId, profile);

  expect(result.status).toBe("paused");
  expect(result.steps).toBe(1);
});

test("the raw provider response never enters the persisted model.response event", async () => {
  const store = memoryStore();
  const profile = testProfile([]);
  const model = scriptedModel([
    { content: "hello", raw: { huge: "payload" }, requestId: "req-1" },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "go" });

  const result = await wake({ store, model, tools: [] }, sessionId, profile);

  const response = result.events.find((event) => event.type === "model.response");
  expect(response).toBeDefined();
  const turn = (response as { turn: Record<string, unknown> }).turn;
  expect(turn.raw).toBeUndefined();
  expect(turn.requestId).toBe("req-1");
});
