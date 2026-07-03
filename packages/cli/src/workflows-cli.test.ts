import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { githubSignature } from "@oma/adapter-trigger-github";

const cliPath = resolve("packages/cli/src/index.ts");

function scaffoldWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "oma-workflows-cli-"));

  mkdirSync(join(cwd, ".oma/workflows"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/config.json"),
    JSON.stringify({ store: { kind: "sqlite", path: ".oma/sessions.sqlite" }, model: { kind: "fake" } })
  );
  writeFileSync(
    join(cwd, ".oma/workflows/pr-review.yml"),
    [
      "name: pr-review",
      "title: Review every pull request",
      "trigger:",
      "  on: github:pull_request.opened",
      "  also:",
      "    - github:pull_request.synchronize",
      "  filter:",
      "    payload.draft: false",
      '  session: "review:{payload.repo}#{payload.pr}"',
      "prompt: Review pull request {payload.pr} in {payload.repo}.",
      "agent:",
      "  prompt: You review pull requests.",
      "  tools: [list_files, git_status]",
      "policy:",
      "  maxSteps: 6",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(cwd, ".oma/workflows/fix-issue.yml"),
    [
      "name: fix-issue",
      "prompt: Fix issue {inputs.issue} with severity {inputs.severity}.",
      "agent:",
      "  prompt: You fix issues.",
      "  tools: [list_files, git_status]",
      "inputs:",
      "  issue:",
      "    required: true",
      "  severity:",
      "    default: normal",
      ""
    ].join("\n")
  );

  return cwd;
}

test("workflow validate, inspect, and list", async () => {
  const cwd = scaffoldWorkspace();

  const validated = await runCli(cwd, [
    "workflow",
    "validate",
    ".oma/workflows/pr-review.yml"
  ]);
  expect(validated.stdout).toContain("valid pr-review");

  const inspected = await runCli(cwd, [
    "workflow",
    "inspect",
    ".oma/workflows/pr-review.yml",
    "--json"
  ]);
  const inspection = JSON.parse(inspected.stdout);
  expect(inspection).toMatchObject({
    name: "pr-review",
    triggers: [
      "github:pull_request.opened",
      "github:pull_request.synchronize",
      "manual:run"
    ],
    session: "review:{payload.repo}#{payload.pr}",
    agent: { prompt: "You review pull requests.", tools: ["list_files", "git_status"] }
  });
  expect(inspection.sourceHash).toHaveLength(64);

  const listed = await runCli(cwd, ["workflow", "list", "--json"]);
  const rows = JSON.parse(listed.stdout) as Array<{ name: string }>;
  expect(rows.map((row) => row.name)).toEqual(["fix-issue", "pr-review"]);

  writeFileSync(
    join(cwd, ".oma/workflows/broken.yml"),
    ["name: broken", "promt: typo", "agent:", "  prompt: x", ""].join("\n")
  );
  const invalid = await runCliRaw(cwd, ["workflow", "validate", ".oma/workflows/broken.yml"]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stdout).toContain('Did you mean "prompt"?');
});

test("oma run executes a workflow by bare name with inputs", async () => {
  const cwd = scaffoldWorkspace();

  const missing = await runCliRaw(cwd, ["run", "fix-issue"]);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('Missing required input "issue"');

  const run = await runCli(cwd, ["run", "fix-issue", "--input", "issue=412", "--json"]);
  const output = JSON.parse(run.stdout);
  expect(output.route.type).toBe("spawned");
  expect(output.status).toBe("completed");

  const sessionId = output.route.sessionId as string;
  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as { events: Array<Record<string, unknown>> };
  const types = session.events.map((event) => event.type);

  expect(types.slice(0, 4)).toEqual([
    "session.started",
    "workflow.loaded",
    "workflow.run.started",
    "trigger.received"
  ]);
  expect(session.events.find((event) => event.type === "workflow.run.started")).toMatchObject({
    name: "fix-issue",
    trigger: { source: "manual", kind: "run" },
    inputs: { issue: "412", severity: "normal" }
  });
  expect(session.events.find((event) => event.type === "message.user")).toMatchObject({
    content: "Fix issue 412 with severity normal."
  });
});

test("trigger emit routes signals through a workflow into a keyed session", async () => {
  const cwd = scaffoldWorkspace();
  const payload = JSON.stringify({ repo: "owner/repo", pr: 42, draft: false });

  const first = await runCli(cwd, [
    "trigger",
    "emit",
    ".oma/workflows/pr-review.yml",
    "github",
    "pull_request.opened",
    "--payload",
    payload,
    "--json"
  ]);
  expect(JSON.parse(first.stdout).route).toEqual({
    type: "spawned",
    sessionId: "review:owner/repo#42"
  });

  const second = await runCli(cwd, [
    "trigger",
    "emit",
    ".oma/workflows/pr-review.yml",
    "github",
    "pull_request.synchronize",
    "--payload",
    payload,
    "--json"
  ]);
  expect(JSON.parse(second.stdout).route).toEqual({
    type: "woken",
    sessionId: "review:owner/repo#42"
  });

  const draft = await runCli(cwd, [
    "trigger",
    "emit",
    ".oma/workflows/pr-review.yml",
    "github",
    "pull_request.opened",
    "--payload",
    JSON.stringify({ repo: "owner/repo", pr: 43, draft: true }),
    "--json"
  ]);
  expect(JSON.parse(draft.stdout).route).toEqual({ type: "filtered" });
});

test("GitHub-tool agents validate without a token but refuse to run without one", async () => {
  const cwd = scaffoldWorkspace();

  writeFileSync(
    join(cwd, ".oma/workflows/fix-issue.yml"),
    [
      "name: fix-issue",
      "prompt: Fix issue {inputs.issue}.",
      "agent:",
      "  prompt: You fix issues using GitHub context.",
      "  tools: [get_diff, list_files, git_status]",
      "inputs:",
      "  issue:",
      "    required: true",
      ""
    ].join("\n")
  );

  const validated = await runCli(cwd, ["workflow", "validate", ".oma/workflows/fix-issue.yml"]);
  expect(validated.stdout).toContain("valid fix-issue");

  const withoutToken = await runCliRaw(
    cwd,
    ["run", "fix-issue", "--input", "issue=1"],
    { GITHUB_TOKEN: "" }
  );
  expect(withoutToken.exitCode).toBe(1);
  expect(withoutToken.stderr).toContain("GITHUB_TOKEN is not set");

  const withToken = await runCli(
    cwd,
    ["run", "fix-issue", "--input", "issue=1", "--json"],
    { GITHUB_TOKEN: "test-token" }
  );
  expect(JSON.parse(withToken.stdout).status).toBe("completed");
});

test("serve webhooks verifies GitHub deliveries and routes them to workflows", async () => {
  const cwd = scaffoldWorkspace();
  const secret = "hook-secret";
  const proc = Bun.spawn(
    ["bun", cliPath, "serve", "webhooks", "--port", "0", "--github-secret", secret],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );

  try {
    const url = await readServerUrl(proc.stdout);

    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "abc" },
        base: { sha: "def" }
      },
      repository: { full_name: "owner/repo" }
    });
    const unsigned = await fetch(`${url}/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "pull_request" },
      body
    });
    expect(unsigned.status).toBe(400);

    const signed = await fetch(`${url}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": githubSignature(body, secret)
      },
      body
    });
    const responseText = await signed.text();
    let result: {
      signal: { source: string; kind: string };
      result: { workflow: string; route: { type: string; sessionId: string } };
    };

    try {
      result = JSON.parse(responseText);
    } catch {
      proc.kill();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Non-JSON webhook response (${signed.status}): ${responseText}\nserver stderr: ${stderr}`
      );
    }

    expect(signed.status).toBe(200);
    expect(result.signal).toMatchObject({ source: "github", kind: "pull_request.opened" });
    expect(result.result).toMatchObject({
      workflow: "pr-review",
      route: { type: "spawned", sessionId: "review:owner/repo#42" }
    });
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

test("staged issue-to-pr demo: approval pause, judge loop, durable trace", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-staged-"));
  mkdirSync(join(cwd, ".oma"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/config.json"),
    JSON.stringify({ store: { kind: "sqlite", path: ".oma/sessions.sqlite" }, model: { kind: "fake" } })
  );
  const workflowPath = resolve("examples/issue-to-pr-demo/workflow.yml");

  const paused = await runCli(cwd, ["run", workflowPath, "--input", "issue=412", "--json"]);
  const pausedOutput = JSON.parse(paused.stdout);
  const sessionId = pausedOutput.route.sessionId as string;

  expect(pausedOutput.status).toBe("paused");
  expect(pausedOutput.awaiting).toEqual({ stage: "plan", iteration: 1 });

  // Waking a paused staged session without deciding stays paused, re-runs nothing.
  const rewake = await runCli(cwd, ["wake", sessionId, "--json"]);
  expect(JSON.parse(rewake.stdout)).toMatchObject({
    status: "paused",
    awaiting: { stage: "plan", iteration: 1 }
  });

  const approved = await runCli(cwd, ["approve", sessionId, "--json"]);
  expect(JSON.parse(approved.stdout).status).toBe("completed");

  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as {
    events: Array<{ type: string; stage?: string; iteration?: number; status?: string }>;
  };
  const stageEvents = session.events
    .filter((event) => event.type === "workflow.stage.completed")
    .map((event) => `${event.stage}#${event.iteration}`);

  expect(stageEvents).toEqual(["plan#1", "execute#1", "review#1", "execute#2", "review#2"]);
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "completed"
  });

  // The executor is one durable conversation: its second message carries the
  // judge's feedback verbatim.
  const executeShown = await runCli(cwd, ["show", `${sessionId}/execute`, "--json"]);
  const executeSession = JSON.parse(executeShown.stdout) as {
    events: Array<{ type: string; content?: string }>;
  };
  const userMessages = executeSession.events.filter((event) => event.type === "message.user");

  expect(userMessages).toHaveLength(2);
  expect(userMessages[1]!.content).toContain("no regression test for interpolated keys");

  // A completed staged workflow re-wakes as a no-op.
  const done = await runCli(cwd, ["wake", sessionId, "--json"]);
  expect(JSON.parse(done.stdout).status).toBe("completed");
});

test("deny stops a staged workflow with the reason recorded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-staged-deny-"));
  mkdirSync(join(cwd, ".oma"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/config.json"),
    JSON.stringify({ store: { kind: "sqlite", path: ".oma/sessions.sqlite" }, model: { kind: "fake" } })
  );
  const workflowPath = resolve("examples/issue-to-pr-demo/workflow.yml");

  const paused = await runCli(cwd, ["run", workflowPath, "--input", "issue=9", "--json"]);
  const sessionId = JSON.parse(paused.stdout).route.sessionId as string;

  const denied = await runCli(cwd, ["deny", sessionId, "--reason", "wrong approach", "--json"]);
  expect(JSON.parse(denied.stdout)).toMatchObject({
    status: "denied",
    reason: "wrong approach"
  });

  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as { events: Array<{ type: string }> };
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "denied"
  });
});

function scaffoldBareWorkspace(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(cwd, ".oma"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/config.json"),
    JSON.stringify({ store: { kind: "sqlite", path: ".oma/sessions.sqlite" }, model: { kind: "fake" } })
  );
  return cwd;
}

test("effects policy: denied tools error, gated tools pause and execute on approve", async () => {
  const cwd = scaffoldBareWorkspace("oma-effects-");
  const workflowPath = resolve("examples/issue-to-pr-demo/effects-demo.yml");

  const run = await runCli(cwd, ["run", workflowPath, "--json"]);
  const output = JSON.parse(run.stdout);
  const sessionId = output.route.sessionId as string;

  expect(output.status).toBe("paused");

  const events = output.events as Array<Record<string, any>>;
  const denied = events.find((event) => event.type === "tool.error");

  expect(denied).toMatchObject({
    toolName: "bash",
    error: { name: "EffectDenied" }
  });
  expect(events.find((event) => event.type === "human.approval.requested")).toMatchObject({
    toolName: "write_file"
  });
  // The gated call is durable with its exact args, but has not executed.
  expect(events.some((event) => event.type === "tool.result")).toBe(false);

  const approved = await runCli(cwd, ["approve", sessionId, "--json"]);
  expect(JSON.parse(approved.stdout).status).toBe("completed");

  const written = await Bun.file(join(cwd, "notes.txt")).text();
  expect(written).toBe("hello from the workflow");
});

test("effects policy: denying the gated tool records the refusal and completes", async () => {
  const cwd = scaffoldBareWorkspace("oma-effects-deny-");
  const workflowPath = resolve("examples/issue-to-pr-demo/effects-demo.yml");

  const run = await runCli(cwd, ["run", workflowPath, "--json"]);
  const sessionId = JSON.parse(run.stdout).route.sessionId as string;

  const denied = await runCli(cwd, ["deny", sessionId, "--reason", "not now", "--json"]);
  expect(JSON.parse(denied.stdout).status).toBe("completed");

  expect(await Bun.file(join(cwd, "notes.txt")).exists()).toBe(false);

  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as { events: Array<Record<string, any>> };
  const errors = session.events.filter((event) => event.type === "tool.error");

  expect(errors).toHaveLength(2); // bash denied by policy, write_file denied by human
  expect(errors[1]).toMatchObject({
    toolName: "write_file",
    error: { name: "EffectDenied" }
  });
});

test("token budgets pause the run with the accounting in the reason", async () => {
  const cwd = scaffoldBareWorkspace("oma-budget-");
  const workflowPath = resolve("examples/issue-to-pr-demo/budget-demo.yml");

  const run = await runCli(cwd, ["run", workflowPath, "--json"]);
  const output = JSON.parse(run.stdout);

  expect(output.status).toBe("paused");

  const paused = (output.events as Array<Record<string, any>>).filter(
    (event) => event.type === "run.paused"
  );
  expect(paused.at(-1)?.reason).toContain("budget:tokens");

  // The ceiling is hard: waking without raising the budget pauses again.
  const rewake = await runCli(cwd, ["wake", output.route.sessionId, "--json"]);
  const rewakeOutput = JSON.parse(rewake.stdout);
  expect(rewakeOutput.status).toBe("paused");
  expect(rewakeOutput.reason).toContain("budget:tokens");
});

test("secret refs resolve harness-side and only exposed names reach the sandbox", async () => {
  const cwd = scaffoldBareWorkspace("oma-secrets-");
  const workflowPath = resolve("examples/issue-to-pr-demo/env-demo.yml");

  const missing = await runCliRaw(cwd, ["run", workflowPath, "--json"], {
    OMA_DEMO_SECRET_SOURCE: ""
  });
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain("OMA_DEMO_SECRET_SOURCE is not set");

  const run = await runCli(cwd, ["run", workflowPath, "--json"], {
    OMA_DEMO_SECRET_SOURCE: "s3cret-sauce"
  });
  const output = JSON.parse(run.stdout);

  expect(output.status).toBe("completed");

  const result = (output.events as Array<Record<string, any>>).find(
    (event) => event.type === "tool.result"
  );
  expect(result?.result?.stdout?.trim()).toBe("s3cret-sauce");
});

test("placement: local run dispatches to a worker; the right worker completes it", async () => {
  const cwd = scaffoldBareWorkspace("oma-worker-");
  const workflowPath = resolve("examples/issue-to-pr-demo/placed-demo.yml");

  const run = await runCli(cwd, ["run", workflowPath, "--input", "issue=7", "--json"]);
  const output = JSON.parse(run.stdout);
  const sessionId = output.route.sessionId as string;

  expect(output.status).toBe("paused");
  expect(output.reason).toContain("worker:mac-mini");
  expect(
    (output.events as Array<{ type: string }>).filter(
      (event) => event.type === "workflow.stage.dispatched"
    )
  ).toHaveLength(1);

  // A worker with the wrong name is a deterministic no-op.
  const wrong = await runCli(cwd, ["worker", "--name", "other", "--once", "--json"]);
  const wrongResults = JSON.parse(wrong.stdout) as Array<{ status: string; reason?: string }>;
  expect(wrongResults[0]).toMatchObject({ status: "paused" });
  expect(wrongResults[0]!.reason).toContain("worker:mac-mini");

  // The matching worker claims the session and finishes the whole loop —
  // including the review stage, since unplaced stages run wherever
  // orchestration currently is.
  const right = await runCli(cwd, ["worker", "--name", "mac-mini", "--once", "--json"]);
  const rightResults = JSON.parse(right.stdout) as Array<{ sessionId: string; status: string }>;
  expect(rightResults).toEqual([{ sessionId, status: "completed" }]);

  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as {
    events: Array<{ type: string; stage?: string; iteration?: number }>;
  };
  const stages = session.events
    .filter((event) => event.type === "workflow.stage.completed")
    .map((event) => `${event.stage}#${event.iteration}`);

  expect(stages).toEqual(["plan#1", "execute#1", "review#1", "execute#2", "review#2"]);
  expect(session.events.at(-1)).toMatchObject({
    type: "workflow.run.completed",
    status: "completed"
  });

  // Idle workers find nothing to do on completed sessions.
  const idle = await runCli(cwd, ["worker", "--name", "mac-mini", "--once", "--json"]);
  expect(JSON.parse(idle.stdout)).toEqual([]);
});

test("context packs: two workflows on one repo record what each model was shown", async () => {
  const cwd = scaffoldBareWorkspace("oma-context-");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(join(cwd, ".oma/workflows"), { recursive: true });
  writeFileSync(
    join(cwd, "src/auth.ts"),
    "export function login(user: string): boolean {\n  return user.length > 0;\n}\n"
  );
  writeFileSync(join(cwd, "src/big.ts"), `export const rows = [\n${'  "row",\n'.repeat(300)}];\n`);
  writeFileSync(
    join(cwd, ".oma/workflows/tight.yml"),
    [
      "name: tight",
      "prompt: Summarize the auth module.",
      "agent:",
      "  prompt: You summarize code.",
      "  tools: [list_files, git_status]",
      "context:",
      "  include: [src/auth.ts]",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(cwd, ".oma/workflows/mapped.yml"),
    [
      "name: mapped",
      "prompt: Summarize everything.",
      "agent:",
      "  prompt: You summarize code.",
      "  tools: [list_files, git_status]",
      "context:",
      "  include: [src/**]",
      "  budget: 300",
      ""
    ].join("\n")
  );

  const tight = await runCli(cwd, ["run", "tight", "--json"]);
  const tightOutput = JSON.parse(tight.stdout);
  const tightPack = (tightOutput.events as Array<Record<string, any>>).find(
    (event) => event.type === "context.pack.built"
  );

  expect(tightPack).toBeDefined();
  expect(tightPack!.files).toHaveLength(1);
  expect(tightPack!.files[0]).toMatchObject({ path: "src/auth.ts", mode: "full" });
  expect(tightPack!.files[0].hash).toHaveLength(64);

  const tightMessage = (tightOutput.events as Array<Record<string, any>>).find(
    (event) => event.type === "message.user"
  );
  expect(tightMessage!.content).toStartWith("<context>");
  expect(tightMessage!.content).toContain("export function login");
  expect(tightMessage!.content).toContain("Summarize the auth module.");

  const mapped = await runCli(cwd, ["run", "mapped", "--json"]);
  const mappedPack = (JSON.parse(mapped.stdout).events as Array<Record<string, any>>).find(
    (event) => event.type === "context.pack.built"
  );

  // The 300-token budget forces big.ts down: demoted to a codemap or dropped,
  // with the decision recorded either way.
  expect(mappedPack!.budget).toBe(300);
  expect(mappedPack!.totalTokens).toBeLessThanOrEqual(300);
  const bigFile = mappedPack!.files.find((file: { path: string }) => file.path === "src/big.ts");
  const bigDropped = (mappedPack!.dropped ?? []).find(
    (drop: { path: string }) => drop.path === "src/big.ts"
  );
  expect(bigFile?.demoted === true || bigDropped !== undefined).toBe(true);
  expect(mappedPack!.packId).not.toBe(tightPack!.packId);

  // The preview command shows the same fit without running a model.
  const preview = await runCli(cwd, ["workflow", "context", ".oma/workflows/mapped.yml", "--json"]);
  const previewPack = JSON.parse(preview.stdout);
  expect(previewPack.packId).toBe(mappedPack!.packId);
});

async function readServerUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = /webhooks listening on (\S+)/.exec(buffer);

    if (match) {
      return match[1]!;
    }
  }

  throw new Error(`Server did not print its URL. Output: ${buffer}`);
}

async function runCli(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await runCliRaw(cwd, args, env);

  if (result.exitCode !== 0) {
    throw new Error(`CLI failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

async function runCliRaw(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env }
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  return { stdout, stderr, exitCode };
}
