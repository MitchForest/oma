import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { routeTriggerSignal } from "@oma/core";
import {
  compileWorkflow,
  interpolateTemplate,
  manualTriggerSignal,
  matchesWorkflowFilter,
  resolveWorkflowInputs,
  signalContext
} from "./compile";
import { loadWorkflowDocument, listWorkflowFiles, resolveWorkflowName } from "./loader";
import { workflowDataSchema } from "./schema";

const inlineAgent = {
  prompt: "You review pull requests.",
  tools: []
};

const workflowFixture = {
  name: "pr-review",
  title: "Review every pull request",
  trigger: {
    on: "github:pull_request.opened",
    also: ["github:pull_request.synchronize"],
    filter: { "payload.draft": false },
    session: "review:{payload.repo}#{payload.pr}"
  },
  prompt: "Review pull request {payload.pr} in {payload.repo}.",
  agent: inlineAgent,
  policy: { maxSteps: 4 }
};

test("workflow schema applies defaults and rejects typos with hints", () => {
  const parsed = workflowDataSchema.parse({
    name: "minimal",
    prompt: "do the thing",
    agent: inlineAgent
  });

  expect(parsed.inputs).toEqual({});
  expect(parsed.policy).toEqual({});
  expect(parsed.agent?.sandbox).toBe("local");
  expect(parsed.trigger).toBeUndefined();

  const typo = workflowDataSchema.safeParse({
    name: "typo",
    prompt: "go",
    agent: inlineAgent,
    trigger: { on: "github:x", fitler: { a: 1 } }
  });

  expect(typo.success).toBe(false);

  const badPattern = workflowDataSchema.safeParse({
    name: "bad",
    prompt: "go",
    agent: inlineAgent,
    trigger: { on: "no-separator" }
  });

  expect(badPattern.success).toBe(false);

  // A single-stage workflow without an agent is an authoring error.
  const missingAgent = workflowDataSchema.safeParse({ name: "x", prompt: "go" });
  expect(missingAgent.success).toBe(false);

  // Staged workflows need an agent per stage or a workflow default.
  const staged = workflowDataSchema.safeParse({
    name: "staged",
    stages: { only: { prompt: "go" } }
  });
  expect(staged.success).toBe(false);

  const stagedWithAgents = workflowDataSchema.safeParse({
    name: "staged",
    stages: { only: { prompt: "go", agent: inlineAgent } }
  });
  expect(stagedWithAgents.success).toBe(true);

  // Docker sandboxes require an image.
  const docker = workflowDataSchema.safeParse({
    name: "docker",
    prompt: "go",
    agent: { prompt: "x", sandbox: { kind: "docker" } }
  });
  expect(docker.success).toBe(false);
});

test("loader hashes source, compiles agents, and loads instructions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-workflows-"));
  mkdirSync(join(dir, ".oma/workflows"), { recursive: true });
  writeFileSync(join(dir, ".oma/workflows/style.md"), "# Style\n\nBe concise.\n");

  const workflowPath = join(dir, ".oma/workflows/pr-review.yml");
  writeFileSync(
    workflowPath,
    [
      "name: pr-review",
      "trigger:",
      "  on: github:pull_request.opened",
      '  session: "review:{payload.repo}#{payload.pr}"',
      "prompt: Review PR {payload.pr}.",
      "agent:",
      "  prompt: You review pull requests.",
      "  instructions: [style.md]",
      "  tools: [read_file]",
      "policy:",
      "  onToolError: fail",
      ""
    ].join("\n")
  );

  const loaded = await loadWorkflowDocument(workflowPath);

  expect(loaded.workflow?.name).toBe("pr-review");
  expect(loaded.sourceHash).toHaveLength(64);
  expect(loaded.diagnostics).toEqual([]);

  const agent = loaded.agents?.default;
  expect(agent?.profile.name).toBe("pr-review");
  expect(agent?.profile.systemPrompt).toBe("You review pull requests.");
  // Instruction files resolve relative to the workflow and land as prompt material.
  expect(agent?.profile.skills[0]).toContain("Be concise.");
  expect(agent?.profile.tools).toEqual(["read_file"]);
  expect(agent?.profile.policy.toolError).toBe("fail");

  // Same source, same hash: the log records exactly which version ran.
  const reloaded = await loadWorkflowDocument(workflowPath);
  expect(reloaded.sourceHash).toBe(loaded.sourceHash!);

  const typoPath = join(dir, ".oma/workflows/typo.yml");
  writeFileSync(
    typoPath,
    ["name: typo", "promt: go", "agent:", "  prompt: x", ""].join("\n")
  );
  const typo = await loadWorkflowDocument(typoPath);
  const unknown = typo.diagnostics.find((d) => d.code === "workflow.unknown_field");

  expect(unknown?.hint).toContain('"prompt"');

  const missingInstructions = join(dir, ".oma/workflows/missing.yml");
  writeFileSync(
    missingInstructions,
    [
      "name: missing",
      "prompt: go",
      "agent:",
      "  prompt: x",
      "  instructions: [nowhere.md]",
      ""
    ].join("\n")
  );
  const missing = await loadWorkflowDocument(missingInstructions);
  expect(
    missing.diagnostics.find((d) => d.code === "workflow.instructions_missing")
  ).toBeDefined();

  const notFound = await loadWorkflowDocument(join(dir, ".oma/workflows/nope.yml"));
  expect(notFound.diagnostics[0]?.code).toBe("workflow.not_found");

  const files = await listWorkflowFiles(join(dir, ".oma/workflows"));
  expect(files).toHaveLength(3);
  expect(await resolveWorkflowName("pr-review", join(dir, ".oma/workflows"))).toBe(workflowPath);
  expect(await resolveWorkflowName("nope", join(dir, ".oma/workflows"))).toBeUndefined();
});

test("policy blocks parse: effects, budgets, env, stage agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-workflows-policy-"));
  const budgetPath = join(dir, "budget.yml");
  writeFileSync(
    budgetPath,
    [
      "name: budget",
      "prompt: go",
      "agent: { prompt: x }",
      "policy:",
      "  budget:",
      "    tokens: 2M",
      "    wall: 30m",
      "  effects:",
      "    post_review: allow",
      '    "*": deny',
      "env:",
      "  secrets:",
      "    GITHUB_TOKEN: env://GITHUB_TOKEN",
      "  expose: [GITHUB_TOKEN]",
      ""
    ].join("\n")
  );
  const budget = await loadWorkflowDocument(budgetPath);
  expect(budget.diagnostics).toEqual([]);
  expect(budget.workflow?.policy.budget).toEqual({ tokens: "2M", wall: "30m" });
  expect(budget.workflow?.policy.effects).toEqual({ post_review: "allow", "*": "deny" });
  expect(budget.workflow?.env?.secrets).toEqual({ GITHUB_TOKEN: "env://GITHUB_TOKEN" });

  const badExposePath = join(dir, "bad-expose.yml");
  writeFileSync(
    badExposePath,
    [
      "name: bad-expose",
      "prompt: go",
      "agent: { prompt: x }",
      "env:",
      "  expose: [MISSING]",
      ""
    ].join("\n")
  );
  const badExpose = await loadWorkflowDocument(badExposePath);
  expect(
    badExpose.diagnostics.find((d) => d.path === "env.expose")?.message
  ).toContain('undeclared secret "MISSING"');

  const stagedPath = join(dir, "staged.yml");
  writeFileSync(
    stagedPath,
    [
      "name: staged",
      "agent: { prompt: default agent }",
      "stages:",
      "  plan:",
      "    prompt: Plan.",
      "  review:",
      "    agent: { prompt: judge agent, model: judge-model }",
      "    prompt: Review.",
      ""
    ].join("\n")
  );
  const staged = await loadWorkflowDocument(stagedPath);
  expect(staged.diagnostics).toEqual([]);
  // Stages without an agent inherit the default; declared agents are complete.
  expect(staged.agents?.stages.plan?.profile.systemPrompt).toBe("default agent");
  expect(staged.agents?.stages.review?.profile.systemPrompt).toBe("judge agent");
  expect(staged.agents?.stages.review?.model).toBe("judge-model");
  expect(staged.agents?.stages.review?.profile.name).toBe("staged/review");
});

test("interpolation, filters, and manual inputs behave deterministically", () => {
  const signal = {
    source: "github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42, draft: false }
  };

  expect(interpolateTemplate("Review {payload.pr} in {payload.repo}.", signalContext(signal))).toBe(
    "Review 42 in owner/repo."
  );
  expect(() => interpolateTemplate("{payload.missing}", signalContext(signal))).toThrow(
    "payload.missing"
  );

  expect(matchesWorkflowFilter({ "payload.draft": false }, signal)).toBe(true);
  expect(matchesWorkflowFilter({ "payload.draft": true }, signal)).toBe(false);
  expect(matchesWorkflowFilter({ kind: "pull_request.opened" }, signal)).toBe(true);

  const workflow = workflowDataSchema.parse({
    name: "manual",
    prompt: "Fix issue {inputs.issue} with severity {inputs.severity}.",
    agent: inlineAgent,
    inputs: {
      issue: { required: true },
      severity: { default: "normal" }
    }
  });

  const missing = resolveWorkflowInputs(workflow, {});
  expect(missing.errors[0]).toContain('"issue"');

  const unknown = resolveWorkflowInputs(workflow, { issue: "412", extra: "x" });
  expect(unknown.errors[0]).toContain('"extra"');

  const resolved = resolveWorkflowInputs(workflow, { issue: "412" });
  expect(resolved.errors).toEqual([]);
  expect(resolved.inputs).toEqual({ issue: "412", severity: "normal" });

  const manual = manualTriggerSignal(workflow, resolved.inputs);
  expect(interpolateTemplate(workflow.prompt!, signalContext(manual))).toBe(
    "Fix issue 412 with severity normal."
  );
});

test("compiled workflow routes signals into keyed sessions with workflow events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-workflows-route-"));
  const workflowPath = join(dir, "pr-review.yml");
  // Build via the loader so the compiled agent is the real path.
  writeFileSync(
    workflowPath,
    [
      "name: pr-review",
      "trigger:",
      "  on: github:pull_request.opened",
      "  also: [github:pull_request.synchronize]",
      "  filter: { payload.draft: false }",
      '  session: "review:{payload.repo}#{payload.pr}"',
      "prompt: Review pull request {payload.pr} in {payload.repo}.",
      "agent: { prompt: You review pull requests. }",
      "policy: { maxSteps: 4 }",
      ""
    ].join("\n")
  );
  const loaded = await loadWorkflowDocument(workflowPath);
  const compiled = compileWorkflow(loaded.workflow!, {
    profile: loaded.agents!.default!.profile,
    sourceHash: "hash-abc",
    sourcePath: ".oma/workflows/pr-review.yml"
  });

  expect(compiled.triggers.map((trigger) => trigger.on)).toEqual([
    "github:pull_request.opened",
    "github:pull_request.synchronize",
    "manual:run"
  ]);
  expect(compiled.maxSteps).toBe(4);

  const store = new MemorySessionStore();
  const runtime = {
    store,
    model: new FakeModelProvider([
      { content: "reviewed" },
      { finishReason: "done" as const },
      { content: "reviewed again" },
      { finishReason: "done" as const }
    ]),
    tools: []
  };
  const signal = {
    source: "github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42, draft: false }
  };

  const draft = await routeTriggerSignal(
    runtime,
    compiled.triggers[0]!,
    { ...signal, payload: { ...signal.payload, draft: true } },
    { spawnEvents: compiled.spawnEvents, signalEvents: compiled.signalEvents(signal) }
  );
  expect(draft.type).toBe("filtered");

  const first = await routeTriggerSignal(runtime, compiled.triggers[0]!, signal, {
    maxSteps: compiled.maxSteps,
    spawnEvents: compiled.spawnEvents,
    signalEvents: compiled.signalEvents(signal)
  });

  expect(first).toEqual({ type: "spawned", sessionId: "review:owner/repo#42" });

  const followUp = { ...signal, kind: "pull_request.synchronize" };
  const second = await routeTriggerSignal(runtime, compiled.triggers[1]!, followUp, {
    maxSteps: compiled.maxSteps,
    spawnEvents: compiled.spawnEvents,
    signalEvents: compiled.signalEvents(followUp)
  });

  expect(second).toEqual({ type: "woken", sessionId: "review:owner/repo#42" });

  const session = await store.getSession("review:owner/repo#42");
  const types = session.events.map((event) => event.type);

  expect(types.slice(0, 4)).toEqual([
    "session.started",
    "workflow.loaded",
    "workflow.run.started",
    "trigger.received"
  ]);
  expect(types.filter((type) => type === "workflow.loaded")).toHaveLength(1);
  expect(types.filter((type) => type === "workflow.run.started")).toHaveLength(2);
  expect(
    session.events.find((event) => event.type === "message.user")
  ).toMatchObject({ content: "Review pull request 42 in owner/repo." });
});
