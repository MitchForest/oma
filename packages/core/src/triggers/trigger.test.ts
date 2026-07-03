import { expect, test } from "bun:test";
import { defineProfile } from "../profiles/profile";
import { defineTool } from "../tools/tool";
import { MemoryWakeLock } from "../harness/wake-lock";
import { defineTrigger, matchesTrigger, routeTriggerSignal } from "./trigger";
import type { ModelProvider, ModelTurn } from "../model/provider";
import {
  createEventId,
  createTimestamp,
  type NewSessionEvent,
  type SessionEvent
} from "../session/events";
import type {
  AppendEventOptions,
  CreateSessionOptions,
  ForkSessionOptions,
  GetSessionOptions,
  SessionRecord,
  SessionStore,
  SubscribeOptions
} from "../session/store";

const profile = defineProfile({
  name: "trigger-test",
  mode: "automation",
  systemPrompt: "system",
  skills: [],
  tools: ["noop"],
  sandboxPolicy: { kind: "local" },
  modelDefaults: {},
  policy: { toolError: "fail" },
  sessionKey: "review:{payload.repo}#{payload.pr}"
});

const tools = [defineTool({ name: "noop", handler: async () => ({ ok: true }) })];

test("matchesTrigger supports exact and wildcard source-kind patterns", () => {
  const signal = {
    source: "github",
    kind: "pull_request.synchronize",
    payload: {}
  };

  expect(matchesTrigger(defineTrigger({ on: "github:pull_request.synchronize", profile, prompt: "go" }), signal)).toBe(true);
  expect(matchesTrigger(defineTrigger({ on: "github:pull_request.*", profile, prompt: "go" }), signal)).toBe(true);
  expect(matchesTrigger(defineTrigger({ on: "github:*", profile, prompt: "go" }), signal)).toBe(true);
  expect(matchesTrigger(defineTrigger({ on: "github:issues.*", profile, prompt: "go" }), signal)).toBe(false);
  expect(matchesTrigger(defineTrigger({ on: "slack:*", profile, prompt: "go" }), signal)).toBe(false);
});

test("routeTriggerSignal ignores non-matching triggers and filters matching signals", async () => {
  const runtime = {
    store: new TestSessionStore(),
    model: new TestModelProvider([{ finishReason: "done" }]),
    tools
  };
  const ignored = defineTrigger({
    on: "github:issues.*",
    profile,
    prompt: "ignored"
  });
  const filtered = defineTrigger({
    on: "github:pull_request.*",
    profile,
    filter: () => false,
    prompt: "filtered"
  });
  const signal = {
    source: "github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42 }
  };

  expect(await routeTriggerSignal(runtime, ignored, signal)).toEqual({ type: "ignored" });
  expect(await routeTriggerSignal(runtime, filtered, signal)).toEqual({ type: "filtered" });
  expect(await runtime.store.exists("review:owner/repo#42")).toBe(false);
});

test("routeTriggerSignal appends trigger metadata and wakes keyed sessions", async () => {
  const store = new TestSessionStore();
  const runtime = {
    store,
    model: new TestModelProvider([{ finishReason: "done" }, { finishReason: "done" }]),
    tools,
    wakeLock: new MemoryWakeLock()
  };
  const trigger = defineTrigger({
    on: "github:pull_request.*",
    profile,
    prompt: (signal) => `review ${(signal.payload as { pr: number }).pr}`
  });
  const signal = {
    source: "github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42 },
    deliveryId: "delivery-1",
    receivedAt: "2026-01-01T00:00:00.000Z",
    metadata: { action: "opened" }
  };

  const first = await routeTriggerSignal(runtime, trigger, signal);
  const second = await routeTriggerSignal(runtime, trigger, {
    ...signal,
    kind: "pull_request.synchronize",
    deliveryId: "delivery-2",
    metadata: { action: "synchronize" }
  });
  const session = await store.getSession("review:owner/repo#42");

  expect(first).toEqual({ type: "spawned", sessionId: "review:owner/repo#42" });
  expect(second).toEqual({ type: "woken", sessionId: "review:owner/repo#42" });
  expect(session.events.map((event) => event.type).slice(0, 3)).toEqual([
    "session.started",
    "trigger.received",
    "message.user"
  ]);
  expect(session.events.filter((event) => event.type === "trigger.received")).toHaveLength(2);
  expect(session.events.find((event) => event.type === "trigger.received")).toMatchObject({
    deliveryId: "delivery-1",
    metadata: { action: "opened" }
  });
});

test("routeTriggerSignal records spawn events once and signal events on every route", async () => {
  const store = new TestSessionStore();
  const runtime = {
    store,
    model: new TestModelProvider([{ finishReason: "done" }, { finishReason: "done" }]),
    tools,
    wakeLock: new MemoryWakeLock()
  };
  const trigger = defineTrigger({
    on: "github:pull_request.*",
    profile,
    prompt: "review"
  });
  const signal = {
    source: "github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 7 }
  };
  const spawnEvents: NewSessionEvent[] = [
    {
      type: "workflow.loaded",
      name: "pr-review",
      sourcePath: ".oma/workflows/pr-review.yml",
      sourceHash: "hash-1"
    }
  ];
  const signalEvents: NewSessionEvent[] = [
    {
      type: "workflow.run.started",
      name: "pr-review",
      sourceHash: "hash-1",
      trigger: { source: signal.source, kind: signal.kind }
    }
  ];

  await routeTriggerSignal(runtime, trigger, signal, { spawnEvents, signalEvents });
  await routeTriggerSignal(
    runtime,
    trigger,
    { ...signal, kind: "pull_request.synchronize" },
    { spawnEvents, signalEvents }
  );

  const session = await store.getSession("review:owner/repo#7");
  const types = session.events.map((event) => event.type);

  // Spawn events land once, right after session.started; signal events land
  // before trigger.received on every routed signal.
  expect(types.slice(0, 4)).toEqual([
    "session.started",
    "workflow.loaded",
    "workflow.run.started",
    "trigger.received"
  ]);
  expect(types.filter((type) => type === "workflow.loaded")).toHaveLength(1);
  expect(types.filter((type) => type === "workflow.run.started")).toHaveLength(2);
  expect(types.indexOf("workflow.run.started", 4)).toBeLessThan(
    types.indexOf("trigger.received", 4)
  );
});

class TestModelProvider implements ModelProvider {
  info = { provider: "test" };
  private index = 0;

  constructor(private readonly turns: ModelTurn[]) {}

  async turn(): Promise<ModelTurn> {
    return this.turns[this.index++] ?? { finishReason: "done" };
  }
}

class TestSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async createSession(options: CreateSessionOptions = {}): Promise<string> {
    const id = options.id ?? crypto.randomUUID();

    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }

    this.sessions.set(id, {
      id,
      events: [],
      metadata: options.metadata,
      createdAt: createTimestamp()
    });

    return id;
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async appendEvent(
    sessionId: string,
    event: NewSessionEvent,
    options: AppendEventOptions = {}
  ): Promise<SessionEvent> {
    const session = this.requireSession(sessionId);

    if (options.expectedOffset !== undefined && session.events.length !== options.expectedOffset) {
      throw new Error("expectedOffset mismatch");
    }

    const appended = {
      id: createEventId(),
      sessionId,
      offset: session.events.length,
      createdAt: createTimestamp(),
      ...event
    } as SessionEvent;

    session.events.push(appended);
    return appended;
  }

  async getSession(sessionId: string, options: GetSessionOptions = {}): Promise<SessionRecord> {
    const session = this.requireSession(sessionId);

    return {
      ...session,
      events: session.events.slice(options.fromOffset ?? 0)
    };
  }

  async *subscribe(sessionId: string, options: SubscribeOptions = {}): AsyncIterable<SessionEvent> {
    const session = await this.getSession(sessionId, { fromOffset: options.fromOffset });

    yield* session.events;
  }

  async fork(sessionId: string, atOffset: number, options: ForkSessionOptions = {}): Promise<string> {
    const source = this.requireSession(sessionId);
    const id = options.id ?? crypto.randomUUID();
    const events = source.events.slice(0, atOffset + 1).map((event, index) => ({
      ...event,
      id: createEventId(),
      sessionId: id,
      offset: index
    }));

    this.sessions.set(id, {
      id,
      events,
      metadata: options.metadata,
      createdAt: createTimestamp()
    });

    return id;
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return session;
  }
}
