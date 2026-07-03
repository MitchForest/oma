import { expect, test } from "bun:test";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { defineProfile, spawn, type ModelTurn } from "@oma/core";
import { evaluateUntilCondition, parseUntilCondition } from "./conditions";
import { extractStageOutput, outputInstruction } from "./outputs";
import { workflowDataSchema } from "./schema";
import { runWorkflowStages, type StageRuntimeFactory } from "./stages";

const profile = defineProfile({
  name: "stage-test",
  mode: "automation",
  systemPrompt: "system",
  skills: [],
  tools: [],
  sandboxPolicy: { kind: "local" },
  modelDefaults: {},
  policy: { toolError: "fail", maxSteps: 8 }
});

const issueToPr = workflowDataSchema.parse({
  name: "issue-to-pr",
  agent: { prompt: "You do the work." },
  trigger: {
    on: "github:issue.labeled",
    session: "issue:{payload.issue}"
  },
  inputs: { issue: { required: true } },
  stages: {
    plan: {
      prompt: "Plan a fix for issue {inputs.issue}.",
      approve: true,
      output: { summary: "string" }
    },
    execute: {
      prompt: "Implement the plan: {stages.plan.summary}",
      reprompt: "Reviewer feedback: {stages.review.feedback}. Revise your work.",
      output: { summary: "string" }
    },
    review: {
      agent: { prompt: "You judge strictly.", model: "judge-model" },
      prompt: "Review the work: {stages.execute.summary}",
      reprompt: "Re-review after revision: {stages.execute.summary}",
      output: { verdict: "approve | revise", feedback: "string" }
    }
  },
  loop: {
    over: ["execute", "review"],
    until: "review.verdict == approve",
    max: 3
  }
});

function jsonTurn(value: Record<string, unknown>): ModelTurn[] {
  return [
    { content: `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` },
    { finishReason: "done" }
  ];
}

/**
 * Factory handing each stage its full cumulative script. FakeModelProvider
 * indexes turns by the session's recorded model.response count, so re-woken
 * stage sessions continue at the right turn regardless of how many times the
 * factory constructs a provider — the same property real resumes rely on.
 */
function scriptedFactory(scripts: Record<string, ModelTurn[]>): StageRuntimeFactory & {
  calls: string[];
  store: MemorySessionStore;
} {
  const calls: string[] = [];
  const store = new MemorySessionStore();
  const factory = (async ({ name, sessionId }) => {
    calls.push(`${name}@${sessionId}`);
    return {
      runtime: {
        store,
        model: new FakeModelProvider(scripts[name] ?? [{ finishReason: "done" as const }]),
        tools: []
      },
      profile
    };
  }) as StageRuntimeFactory & { calls: string[]; store: MemorySessionStore };
  factory.calls = calls;
  factory.store = store;
  return factory;
}

async function spawnParent(store: MemorySessionStore, id: string, inputs: Record<string, string>) {
  await spawn(store, profile, { id, metadata: { workflowKind: "staged" } });
  await store.appendEvent(id, {
    type: "workflow.loaded",
    name: issueToPr.name,
    sourceHash: "hash-1"
  });
  await store.appendEvent(id, {
    type: "workflow.run.started",
    name: issueToPr.name,
    sourceHash: "hash-1",
    trigger: { source: "manual", kind: "run" },
    inputs
  });
  await store.appendEvent(id, {
    type: "trigger.received",
    source: "manual",
    kind: "run",
    payload: inputs
  });
}

test("condition and output primitives", () => {
  const condition = parseUntilCondition("review.verdict == approve")!;

  expect(condition).toEqual({
    stage: "review",
    field: "verdict",
    operator: "==",
    value: "approve"
  });
  expect(evaluateUntilCondition(condition, { verdict: "approve" })).toBe(true);
  expect(evaluateUntilCondition(condition, { verdict: "revise" })).toBe(false);
  expect(evaluateUntilCondition(condition, undefined)).toBe(false);
  expect(parseUntilCondition("nonsense")).toBeUndefined();
  expect(parseUntilCondition("score.value != 3")!.value).toBe(3);

  const spec = { verdict: "approve | revise", feedback: "string" };

  expect(outputInstruction(spec)).toContain('"verdict": "approve" or "revise"');
  expect(
    extractStageOutput('Text.\n```json\n{"verdict":"approve","feedback":"ok"}\n```', spec).output
  ).toEqual({ verdict: "approve", feedback: "ok" });
  expect(
    extractStageOutput('Trailing {"verdict":"revise","feedback":"needs work"}', spec).output
  ).toEqual({ verdict: "revise", feedback: "needs work" });
  expect(extractStageOutput("no json here", spec).error).toContain("No json");
  expect(
    extractStageOutput('```json\n{"verdict":"maybe","feedback":"x"}\n```', spec).error
  ).toContain("verdict");
});

test("staged workflow pauses for approval, loops on revise, and completes on approve", async () => {
  const factory = scriptedFactory({
    plan: jsonTurn({ summary: "the plan" }),
    execute: [...jsonTurn({ summary: "first attempt" }), ...jsonTurn({ summary: "second attempt" })],
    review: [
      ...jsonTurn({ verdict: "revise", feedback: "tests are missing" }),
      ...jsonTurn({ verdict: "approve", feedback: "looks good" })
    ]
  });
  const store = factory.store;
  const parent = "issue:412";

  await spawnParent(store, parent, { issue: "412" });

  const deps = { store, factory };
  const paused = await runWorkflowStages(deps, issueToPr, {
    parentSessionId: parent,
    sourceHash: "hash-1"
  });

  expect(paused).toEqual({ status: "paused", awaiting: { stage: "plan", iteration: 1 } });

  const afterPause = await store.getSession(parent);
  expect(
    afterPause.events.find((event) => event.type === "human.approval.requested")
  ).toMatchObject({ stage: "plan", iteration: 1 });

  // Approving resumes; the loop then runs revise -> approve.
  await store.appendEvent(parent, {
    type: "human.approval.granted",
    stage: "plan",
    iteration: 1
  });

  const finished = await runWorkflowStages(deps, issueToPr, {
    parentSessionId: parent,
    sourceHash: "hash-1"
  });

  expect(finished.status).toBe("completed");

  const session = await store.getSession(parent);
  const stageEvents = session.events.filter((event) => event.type === "workflow.stage.completed");

  expect(
    stageEvents.map((event) => `${(event as { stage: string }).stage}#${(event as { iteration: number }).iteration}`)
  ).toEqual(["plan#1", "execute#1", "review#1", "execute#2", "review#2"]);
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "completed"
  });

  // The executor session is one durable conversation across iterations, and
  // the second iteration's message carries the reviewer's feedback.
  const executeSession = await store.getSession(`${parent}/execute`);
  const userMessages = executeSession.events.filter((event) => event.type === "message.user");

  expect(userMessages).toHaveLength(2);
  expect((userMessages[0] as { content: string }).content).toContain("the plan");
  expect((userMessages[1] as { content: string }).content).toContain("tests are missing");

  // Resuming a finished workflow re-runs nothing.
  const callsBefore = factory.calls.length;
  const again = await runWorkflowStages(deps, issueToPr, {
    parentSessionId: parent,
    sourceHash: "hash-1"
  });

  expect(again.status).toBe("completed");
  expect(factory.calls.length).toBe(callsBefore);
});

test("denied approvals stop the workflow and max iterations fail it", async () => {
  const deniedFactory = scriptedFactory({
    plan: jsonTurn({ summary: "the plan" })
  });
  const deniedStore = deniedFactory.store;

  await spawnParent(deniedStore, "issue:1", { issue: "1" });
  await runWorkflowStages({ store: deniedStore, factory: deniedFactory }, issueToPr, {
    parentSessionId: "issue:1",
    sourceHash: "h"
  });
  await deniedStore.appendEvent("issue:1", {
    type: "human.approval.denied",
    stage: "plan",
    iteration: 1,
    reason: "wrong approach"
  });

  const denied = await runWorkflowStages({ store: deniedStore, factory: deniedFactory }, issueToPr, {
    parentSessionId: "issue:1",
    sourceHash: "h"
  });

  expect(denied).toMatchObject({ status: "denied", reason: "wrong approach" });

  const alwaysRevise = scriptedFactory({
    plan: jsonTurn({ summary: "plan" }),
    execute: [
      ...jsonTurn({ summary: "a1" }),
      ...jsonTurn({ summary: "a2" }),
      ...jsonTurn({ summary: "a3" })
    ],
    review: [
      ...jsonTurn({ verdict: "revise", feedback: "no" }),
      ...jsonTurn({ verdict: "revise", feedback: "still no" }),
      ...jsonTurn({ verdict: "revise", feedback: "never" })
    ]
  });
  const reviseStore = alwaysRevise.store;

  await spawnParent(reviseStore, "issue:2", { issue: "2" });
  await runWorkflowStages({ store: reviseStore, factory: alwaysRevise }, issueToPr, {
    parentSessionId: "issue:2",
    sourceHash: "h"
  });
  await reviseStore.appendEvent("issue:2", {
    type: "human.approval.granted",
    stage: "plan",
    iteration: 1
  });

  const exhausted = await runWorkflowStages({ store: reviseStore, factory: alwaysRevise }, issueToPr, {
    parentSessionId: "issue:2",
    sourceHash: "h"
  });

  expect(exhausted.status).toBe("max-iterations");

  const session = await reviseStore.getSession("issue:2");
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "max-iterations"
  });
});

test("code workflows coordinate declared stages with replay across pauses", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oma-code-wf-"));
  const modulePath = join(dir, "coordinate.ts");

  writeFileSync(
    modulePath,
    `export default async function ({ stage, inputs }) {
  const plan = await stage("plan");            // approve-gated
  let verdict;
  do {
    await stage("execute");
    verdict = (await stage("review")).verdict;
  } while (verdict !== "approve");
}
`
  );

  const workflow = workflowDataSchema.parse({
    name: "code-loop",
    agent: { prompt: "You do the work." },
    run: "coordinate.ts",
    inputs: { issue: { required: true } },
    stages: {
      plan: { prompt: "Plan {inputs.issue}.", approve: true, output: { summary: "string" } },
      execute: {
        prompt: "Implement: {stages.plan.summary}",
        reprompt: "Feedback: {stages.review.feedback}",
        output: { summary: "string" }
      },
      review: {
        prompt: "Review: {stages.execute.summary}",
        reprompt: "Re-review: {stages.execute.summary}",
        output: { verdict: "approve | revise", feedback: "string" }
      }
    }
  });
  const factory = scriptedFactory({
    plan: jsonTurn({ summary: "the plan" }),
    execute: [...jsonTurn({ summary: "a1" }), ...jsonTurn({ summary: "a2" })],
    review: [
      ...jsonTurn({ verdict: "revise", feedback: "not yet" }),
      ...jsonTurn({ verdict: "approve", feedback: "good" })
    ]
  });
  const store = factory.store;
  const meta = { parentSessionId: "code:1", sourceHash: "h", codeModulePath: modulePath };

  await spawnParent(store, "code:1", { issue: "7" });

  const paused = await runWorkflowStages({ store, factory }, workflow, meta);
  expect(paused).toEqual({ status: "paused", awaiting: { stage: "plan", iteration: 1 } });

  await store.appendEvent("code:1", {
    type: "human.approval.granted",
    stage: "plan",
    iteration: 1
  });

  const planRuns = factory.calls.filter((call) => call.startsWith("plan@")).length;
  const finished = await runWorkflowStages({ store, factory }, workflow, meta);

  expect(finished.status).toBe("completed");
  // The module re-executed from the top, but plan#1 replayed from the log.
  expect(factory.calls.filter((call) => call.startsWith("plan@")).length).toBe(planRuns);

  const session = await store.getSession("code:1");
  const stageEvents = session.events
    .filter((event) => event.type === "workflow.stage.completed")
    .map((event) => `${(event as { stage: string }).stage}#${(event as { iteration: number }).iteration}`);

  expect(stageEvents).toEqual(["plan#1", "execute#1", "review#1", "execute#2", "review#2"]);
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "completed"
  });

  // Undeclared stages are authoring errors surfaced as failed runs.
  const badModule = join(dir, "bad.ts");
  writeFileSync(badModule, `export default async ({ stage }) => { await stage("nope"); };`);

  const badWorkflow = workflowDataSchema.parse({
    name: "code-bad",
    agent: { prompt: "You do the work." },
    run: "bad.ts",
    stages: { plan: { prompt: "x" } }
  });
  const badFactory = scriptedFactory({});

  await spawnParent(badFactory.store, "code:2", {});

  const failed = await runWorkflowStages({ store: badFactory.store, factory: badFactory }, badWorkflow, {
    parentSessionId: "code:2",
    sourceHash: "h",
    codeModulePath: badModule
  });

  expect(failed.status).toBe("failed");
  expect(failed.reason).toContain('stage("nope") is not declared');
});

test("a corrective retry rescues a malformed output block once", async () => {
  const workflow = workflowDataSchema.parse({
    name: "single",
    agent: { prompt: "You do the work." },
    stages: {
      only: {
        prompt: "Do the thing.",
        output: { result: "string" }
      }
    }
  });
  // One cumulative script serves both wakes: the initial reply without json,
  // then the corrective wake's fixed reply.
  const factory = scriptedFactory({
    only: [
      { content: "Done, no json though." },
      { finishReason: "done" },
      { content: 'Sorry.\n```json\n{"result":"fixed"}\n```' },
      { finishReason: "done" }
    ]
  });
  const store = factory.store;

  await spawnParent(store, "s1", {});

  const result = await runWorkflowStages({ store, factory }, workflow, {
    parentSessionId: "s1",
    sourceHash: "h"
  });

  expect(result.status).toBe("completed");

  const session = await store.getSession("s1");
  expect(session.events.find((event) => event.type === "workflow.stage.completed")).toMatchObject({
    output: { result: "fixed" }
  });

  const stageSession = await store.getSession("s1/only");
  const corrective = stageSession.events.filter((event) => event.type === "message.user");
  expect(corrective).toHaveLength(2);
  expect((corrective[1] as { content: string }).content).toContain("did not include");
});

test("placement dispatches stages to workers and takeover never re-executes", async () => {
  const workflow = workflowDataSchema.parse({
    name: "placed",
    agent: { prompt: "You do the work." },
    inputs: { issue: { required: true } },
    stages: {
      plan: { prompt: "Plan {inputs.issue}.", output: { summary: "string" } },
      execute: {
        runs_on: "worker:mac-mini",
        prompt: "Implement: {stages.plan.summary}",
        output: { summary: "string" }
      },
      review: {
        prompt: "Review: {stages.execute.summary}",
        output: { verdict: "approve | revise", feedback: "string" }
      }
    },
    loop: {
      over: ["execute", "review"],
      until: "review.verdict == approve",
      max: 2
    }
  });
  const factory = scriptedFactory({
    plan: jsonTurn({ summary: "the plan" }),
    execute: jsonTurn({ summary: "done on the mini" }),
    review: jsonTurn({ verdict: "approve", feedback: "good" })
  });
  const store = factory.store;

  await spawnParent(store, "placed:1", { issue: "9" });

  // The local runner completes plan, then defers execute to the worker.
  const local = await runWorkflowStages({ store, factory }, workflow, {
    parentSessionId: "placed:1",
    sourceHash: "h"
  });

  expect(local.status).toBe("paused");
  expect(local.reason).toContain("worker:mac-mini");
  expect(local.awaiting).toEqual({ stage: "execute", iteration: 1 });

  const afterLocal = await store.getSession("placed:1");
  expect(
    afterLocal.events.filter((event) => event.type === "workflow.stage.dispatched")
  ).toHaveLength(1);

  // Re-running locally is a deterministic no-op: no duplicate dispatch events.
  const localAgain = await runWorkflowStages({ store, factory }, workflow, {
    parentSessionId: "placed:1",
    sourceHash: "h"
  });
  expect(localAgain.status).toBe("paused");
  expect(
    (await store.getSession("placed:1")).events.filter(
      (event) => event.type === "workflow.stage.dispatched"
    )
  ).toHaveLength(1);

  const planRuns = factory.calls.filter((call) => call.startsWith("plan@")).length;

  // The worker (same store, different placement identity — e.g. after the
  // local process died) picks up the log and finishes everything it can.
  const worker = await runWorkflowStages(
    { store, factory, placement: "worker:mac-mini" },
    workflow,
    { parentSessionId: "placed:1", sourceHash: "h" }
  );

  expect(worker.status).toBe("completed");
  // Takeover replayed plan from the log without re-executing it.
  expect(factory.calls.filter((call) => call.startsWith("plan@")).length).toBe(planRuns);

  const session = await store.getSession("placed:1");
  const stageEvents = session.events
    .filter((event) => event.type === "workflow.stage.completed")
    .map((event) => `${(event as { stage: string }).stage}#${(event as { iteration: number }).iteration}`);

  expect(stageEvents).toEqual(["plan#1", "execute#1", "review#1"]);
});
