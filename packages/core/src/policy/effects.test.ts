import { expect, test } from "bun:test";
import { spawn } from "../entities/entities";
import { wake } from "../harness/harness";
import type { ModelProvider, ModelTurn } from "../model/provider";
import { defineProfile, type Profile } from "../profiles/profile";
import { sessionEventSchema, type SessionEvent } from "../session/events";
import type { SessionStore } from "../session/store";
import { defineTool } from "../tools/tool";
import { matchEffectRule, resolveEffect } from "./effects";

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
      throw new Error("not used in effects tests");
    },
    fork: () => {
      throw new Error("not used in effects tests");
    }
  };
}

function effectsProfile(tools: string[], policy: Record<string, unknown>): Profile {
  return defineProfile({
    name: "effects-test",
    mode: "automation",
    systemPrompt: "test",
    skills: [],
    tools,
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: { toolError: "fail", ...policy }
  });
}

function scriptedModel(turns: ModelTurn[]): ModelProvider {
  let index = 0;

  return {
    info: { provider: "scripted" },
    turn: async () => turns[Math.min(index++, turns.length - 1)] ?? { finishReason: "done" }
  };
}

const readTool = defineTool({
  name: "get_thing",
  effect: "read",
  handler: async () => ({ ok: true })
});

test("resolveEffect matches exact over prefix over catch-all with read-allowed defaults", () => {
  const policy = {
    post_review: "allow",
    "post_*": "approve",
    "*": "deny"
  } as const;

  expect(matchEffectRule(policy, "post_review")).toBe("allow");
  expect(matchEffectRule(policy, "post_inline_comment")).toBe("approve");
  expect(matchEffectRule(policy, "merge_pr")).toBe("deny");

  // No policy at all: unchanged behavior.
  expect(resolveEffect(undefined, undefined, { toolName: "x", callId: "c", args: {} }, [])).toEqual(
    { kind: "allow" }
  );

  // Policy present, no matching rule: reads allowed, writes denied.
  const bare = { post_review: "allow" } as const;
  expect(resolveEffect(bare, readTool, { toolName: "get_thing", callId: "c", args: {} }, [])).toEqual(
    { kind: "allow" }
  );
  const write = resolveEffect(
    bare,
    defineTool({ name: "rm_rf", effect: "write", handler: async () => ({}) }),
    { toolName: "rm_rf", callId: "c", args: {} },
    []
  );
  expect(write.kind).toBe("deny");
});

test("denied effects become tool errors the model can see, never run failures", async () => {
  const store = memoryStore();
  let merges = 0;
  const tools = [
    defineTool({
      name: "merge_pr",
      effect: "external",
      handler: async () => {
        merges += 1;
        return { merged: true };
      }
    })
  ];
  const profile = effectsProfile(["merge_pr"], {
    effects: { merge_pr: "deny" }
  });
  const model = scriptedModel([
    { toolCalls: [{ name: "merge_pr", args: { pr: 1 } }] },
    { content: "Understood, cannot merge." },
    { finishReason: "done" }
  ]);

  await spawn(store, profile, { id: "s1", initialMessage: "merge it" });
  const result = await wake({ store, model, tools }, "s1", profile);

  expect(result.status).toBe("completed");
  expect(merges).toBe(0);

  const error = result.events.find((event) => event.type === "tool.error");
  expect(error).toMatchObject({
    toolName: "merge_pr",
    error: { name: "EffectDenied" }
  });
});

test("approve-gated tools pause the run durably and execute only after a grant", async () => {
  const store = memoryStore();
  let posts = 0;
  const tools = [
    defineTool({
      name: "post_review",
      effect: "external",
      handler: async () => {
        posts += 1;
        return { posted: true };
      }
    })
  ];
  const profile = effectsProfile(["post_review"], {
    effects: { post_review: "approve" }
  });
  const model = scriptedModel([
    { toolCalls: [{ name: "post_review", args: { verdict: "approve" } }] },
    { finishReason: "done" }
  ]);
  const runtime = { store, model, tools };

  await spawn(store, profile, { id: "s1", initialMessage: "review" });
  const first = await wake(runtime, "s1", profile);

  expect(first.status).toBe("waiting");
  expect(first.waitingOn).toMatchObject({ type: "approval", toolName: "post_review" });
  expect(posts).toBe(0);

  const requested = first.events.filter((event) => event.type === "human.approval.requested");
  expect(requested).toHaveLength(1);
  expect(requested[0]).toMatchObject({ toolName: "post_review" });
  const callId = (first.waitingOn as { callId: string }).callId;

  // Waking again without a decision stays waiting and does not re-request.
  const second = await wake(runtime, "s1", profile);
  expect(second.status).toBe("waiting");
  expect(
    second.events.filter((event) => event.type === "human.approval.requested")
  ).toHaveLength(1);
  expect(posts).toBe(0);

  await store.appendEvent("s1", {
    type: "human.approval.granted",
    callId,
    toolName: "post_review"
  });

  const third = await wake(runtime, "s1", profile);
  expect(third.status).toBe("completed");
  expect(posts).toBe(1);
  expect(third.events.find((event) => event.type === "tool.result")).toMatchObject({
    toolName: "post_review"
  });
});

test("a denied approval records a policy error and the run continues", async () => {
  const store = memoryStore();
  let posts = 0;
  const tools = [
    defineTool({
      name: "post_review",
      effect: "external",
      handler: async () => {
        posts += 1;
        return { posted: true };
      }
    })
  ];
  const profile = effectsProfile(["post_review"], {
    effects: { post_review: "approve" }
  });
  const model = scriptedModel([
    { toolCalls: [{ name: "post_review", args: {} }] },
    { content: "Acknowledged." },
    { finishReason: "done" }
  ]);
  const runtime = { store, model, tools };

  await spawn(store, profile, { id: "s1", initialMessage: "go" });
  const first = await wake(runtime, "s1", profile);
  const callId = (first.waitingOn as { callId: string }).callId;

  await store.appendEvent("s1", {
    type: "human.approval.denied",
    callId,
    toolName: "post_review",
    reason: "not today"
  });

  const second = await wake(runtime, "s1", profile);

  expect(second.status).toBe("completed");
  expect(posts).toBe(0);
  expect(second.events.find((event) => event.type === "tool.error")).toMatchObject({
    error: { name: "EffectDenied" }
  });
});

test("max caps real executions and dedupe replays identical calls", async () => {
  const store = memoryStore();
  let comments = 0;
  const tools = [
    defineTool({
      name: "post_comment",
      effect: "external",
      handler: async (args: { body: string }) => {
        comments += 1;
        return { id: comments, body: args.body };
      }
    })
  ];
  const profile = effectsProfile(["post_comment"], {
    effects: { post_comment: { max: 2, dedupe: true } }
  });
  const model = scriptedModel([
    { toolCalls: [{ name: "post_comment", args: { body: "first" } }] },
    { toolCalls: [{ name: "post_comment", args: { body: "first" } }] }, // duplicate
    { toolCalls: [{ name: "post_comment", args: { body: "second" } }] },
    { toolCalls: [{ name: "post_comment", args: { body: "third" } }] }, // over max
    { finishReason: "done" }
  ]);

  await spawn(store, profile, { id: "s1", initialMessage: "comment" });
  const result = await wake(
    { store, model, tools },
    "s1",
    effectsProfile(["post_comment"], {
      toolError: "continue",
      effects: { post_comment: { max: 2, dedupe: true } }
    })
  );

  expect(result.status).toBe("completed");
  expect(comments).toBe(2);

  const results = result.events.filter((event) => event.type === "tool.result");
  expect(results).toHaveLength(3); // two real, one deduped
  expect(results.filter((event) => event.metadata?.deduplicated === true)).toHaveLength(1);

  const denied = result.events.filter(
    (event) => event.type === "tool.error" && event.error.name === "EffectDenied"
  );
  expect(denied).toHaveLength(1);
  expect((denied[0] as { error: { message: string } }).error.message).toContain("caps tool");
});

test("token and wall budgets pause the run resumably", async () => {
  const store = memoryStore();
  const profile = effectsProfile([], {});
  const usageTurn = (content: string): ModelTurn => ({
    content,
    usage: { inputTokens: 400, outputTokens: 200 }
  });
  const model = scriptedModel([
    usageTurn("thinking"),
    usageTurn("more thinking"),
    { finishReason: "done" }
  ]);
  const runtime = { store, model, tools: [] };

  await spawn(store, profile, { id: "s1", initialMessage: "work" });
  const paused = await wake(runtime, "s1", profile, { tokenBudget: 1000 });

  expect(paused.status).toBe("paused");
  expect(paused.pauseReason).toContain("budget:tokens");
  expect(
    paused.events.filter((event) => event.type === "run.paused").at(-1)
  ).toMatchObject({ reason: expect.stringContaining("budget:tokens") });

  // Raising the budget resumes to completion.
  const resumed = await wake(runtime, "s1", profile, { tokenBudget: 10_000 });
  expect(resumed.status).toBe("completed");

  const wallStore = memoryStore();
  await spawn(wallStore, profile, { id: "s2", initialMessage: "work" });
  const wallPaused = await wake(
    { store: wallStore, model: scriptedModel([{ finishReason: "done" }]), tools: [] },
    "s2",
    profile,
    { deadlineAt: Date.now() - 1 }
  );

  expect(wallPaused.status).toBe("paused");
  expect(wallPaused.pauseReason).toBe("budget:wall");
});
