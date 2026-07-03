import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";

const cliPath = resolve("packages/cli/src/index.ts");

/** A minimal single-file workflow exercising the offline fake model. */
function writeInspectWorkflow(cwd: string): void {
  mkdirSync(join(cwd, ".oma/workflows"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/workflows/inspect.yml"),
    [
      "name: inspect",
      "title: Inspect the workspace",
      "agent:",
      "  prompt: You inspect workspaces and report what you find.",
      "  tools: [list_files, git_status]",
      "prompt: Inspect this workspace.",
      ""
    ].join("\n")
  );
}

test("CLI initializes, runs a workflow, shows, sends, lists, and forks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-cli-"));

  await runCli(cwd, ["init"]);
  const config = await runCli(cwd, ["config"]);
  expect(JSON.parse(config.stdout)).toMatchObject({
    store: { kind: "sqlite" },
    model: { kind: "fake" }
  });

  const storeCheck = await runCli(cwd, ["store", "check", "--json"]);
  expect(JSON.parse(storeCheck.stdout)).toMatchObject({
    store: { kind: "sqlite" },
    capabilities: {
      durable: true,
      crossProcessSubscribe: false,
      projections: true,
      runClaims: true
    }
  });

  const sandboxCheck = await runCli(cwd, ["sandbox", "check", "--json"]);
  expect(JSON.parse(sandboxCheck.stdout)).toMatchObject({
    policy: { kind: "local" },
    check: { command: "bun", exitCode: 0 }
  });

  writeInspectWorkflow(cwd);

  const run = await runCli(cwd, ["run", "inspect", "--json"]);
  const output = JSON.parse(run.stdout);
  const sessionId = output.route.sessionId as string;

  expect(output.status).toBe("completed");

  const shown = await runCli(cwd, ["show", sessionId, "--json"]);
  const session = JSON.parse(shown.stdout) as {
    events: Array<{ type: string }>;
    view: { timeline: Array<{ type: string }>; tools: Array<{ toolName: string }> };
  };

  expect(session.events.some((event) => event.type === "workflow.loaded")).toBe(true);
  expect(session.events.some((event) => event.type === "run.completed")).toBe(true);
  expect(session.view.tools.some((tool) => tool.toolName === "git_status")).toBe(true);
  // Sandbox-backed tools record their lifecycle in the log.
  expect(session.events.some((event) => event.type === "sandbox.provisioned")).toBe(true);
  expect(session.events.some((event) => event.type === "sandbox.exec.completed")).toBe(true);
  expect(session.events.some((event) => event.type === "sandbox.destroyed")).toBe(true);

  const shownTimeline = await runCli(cwd, ["show", sessionId, "--timeline"]);
  expect(shownTimeline.stdout).toContain("run.completed");

  // Single-stage workflow sessions take chat; the resume re-reads the YAML.
  const sent = await runCli(cwd, ["send", sessionId, "continue"]);
  expect(sent.stdout).toContain("status  completed");

  const appended = await runCli(cwd, ["send", "--json", "--no-wake", sessionId, "append only"]);
  expect(JSON.parse(appended.stdout)).toMatchObject({ sessionId });

  const list = await runCli(cwd, ["list", "--json"]);
  expect(JSON.stringify(JSON.parse(list.stdout))).toContain(sessionId);

  const fork = await runCli(cwd, ["fork", "--json", sessionId, "0"]);
  expect(JSON.parse(fork.stdout)).toMatchObject({ sessionId, offset: 0 });

  const events = await runCli(cwd, ["events", sessionId]);
  expect(events.stdout).toContain("workflow.run.started");
}, 30_000);

test("CLI initializes memory and postgres store configs", async () => {
  const memoryCwd = mkdtempSync(join(tmpdir(), "oma-cli-memory-"));
  const postgresCwd = mkdtempSync(join(tmpdir(), "oma-cli-postgres-"));

  await runCli(memoryCwd, ["init", "--store", "memory"]);
  expect(JSON.parse((await runCli(memoryCwd, ["config"])).stdout)).toMatchObject({
    store: { kind: "memory" }
  });
  expect(
    JSON.parse((await runCli(memoryCwd, ["store", "capabilities", "--json"])).stdout)
  ).toMatchObject({
    capabilities: {
      durable: false,
      crossProcessSubscribe: false,
      projections: true
    }
  });

  await runCli(postgresCwd, ["init", "--store", "postgres"]);
  expect(JSON.parse((await runCli(postgresCwd, ["config"])).stdout)).toMatchObject({
    store: { kind: "postgres", connectionStringEnv: "DATABASE_URL" }
  });

  // A config without a model key falls back to the offline fake provider.
  await Bun.write(
    join(memoryCwd, ".oma/config.json"),
    `${JSON.stringify({ store: { kind: "memory" }, sandbox: { kind: "local", cwd: "." } }, null, 2)}\n`
  );
  expect(JSON.parse((await runCli(memoryCwd, ["config"])).stdout)).toMatchObject({
    model: { kind: "fake" }
  });
}, 30_000);

test("inline agent sandbox options bind the tools (allowlists enforced)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-cli-sandbox-"));

  await runCli(cwd, ["init"]);
  await Bun.write(
    join(cwd, "restricted-model.ts"),
    `export function createModel() {
  const turns = [
    { toolCalls: [{ name: "bash", args: { command: "touch", args: ["evil.txt"] } }] },
    { content: "done trying" },
    { finishReason: "done" }
  ];

  return {
    info: { provider: "restricted-fake" },
    async turn(input: { events: Array<{ type: string }> }) {
      const responses = input.events.filter((event) => event.type === "model.response").length;
      return turns[responses] ?? { finishReason: "fake-turns-exhausted" };
    }
  };
}
`
  );
  mkdirSync(join(cwd, ".oma/workflows"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/workflows/restricted.yml"),
    [
      "name: restricted",
      "agent:",
      "  prompt: You try to run commands.",
      "  tools: [bash]",
      "  sandbox:",
      "    kind: local",
      "    allowedCommands: [rg]",
      `  model: "module://${join(cwd, "restricted-model.ts")}#createModel"`,
      "prompt: Try to touch a file.",
      "policy: { onToolError: continue }",
      ""
    ].join("\n")
  );

  const run = await runCli(cwd, ["run", "restricted", "--json"]);
  const output = JSON.parse(run.stdout);

  expect(output.status).toBe("completed");

  const toolError = (output.events as Array<Record<string, any>>).find(
    (event) => event.type === "tool.error"
  );
  expect(toolError?.error?.message).toContain("not allowed");
  expect(await Bun.file(join(cwd, "evil.txt")).exists()).toBe(false);
}, 30_000);

test(
  "a killed run resumes through the workflow with zero re-executed tool calls",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oma-cli-resume-"));
    const markerPath = join(cwd, "resume.marker");

    await runCli(cwd, ["init"]);
    await Bun.write(
      join(cwd, "blocking-model.ts"),
      `export function createModel() {
  const turns = [
    {
      toolCalls: [
        {
          name: "bash",
          args: {
            command: "sh",
            args: ["-c", "test -f resume.marker || (touch resume.marker && sleep 20)"]
          }
        }
      ]
    },
    { content: "resumed and finished" },
    { finishReason: "done" }
  ];

  return {
    info: { provider: "blocking-fake" },
    async turn(input: { events: Array<{ type: string }> }) {
      const responses = input.events.filter(
        (event) => event.type === "model.response"
      ).length;
      return turns[responses] ?? { finishReason: "fake-turns-exhausted" };
    }
  };
}
`
    );
    mkdirSync(join(cwd, ".oma/workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".oma/workflows/resume-test.yml"),
      [
        "name: resume-test",
        "agent:",
        "  prompt: You run one blocking command.",
        "  tools: [bash]",
        "  sandbox:",
        "    kind: local",
        "    timeoutMs: 60000",
        `  model: "module://${join(cwd, "blocking-model.ts")}#createModel"`,
        "prompt: Run the blocking command.",
        "policy: { maxSteps: 8, onToolError: fail }",
        ""
      ].join("\n")
    );

    // Start a run whose first tool call blocks for 20s after dropping a
    // marker file, then kill the process mid-run.
    const runProc = Bun.spawn(["bun", cliPath, "run", "resume-test"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    });

    const deadline = Date.now() + 15_000;
    while (!(await Bun.file(markerPath).exists())) {
      if (Date.now() > deadline) {
        runProc.kill();
        throw new Error("blocking tool call never started");
      }

      await Bun.sleep(50);
    }

    runProc.kill("SIGKILL");
    await runProc.exited;

    const list = await runCli(cwd, ["list", "--json"]);
    const sessions = JSON.parse(list.stdout) as Array<{ id: string; status: string }>;
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0]!.id;
    expect(sessions[0]!.status).toBe("running");

    // Wake resumes through the workflow (the dead CLI's claim is stolen via
    // pid liveness): the recorded pending tool call executes instantly since
    // the marker now exists, and the run completes.
    const woken = await runCli(cwd, ["wake", sessionId, "--json"]);
    expect(JSON.parse(woken.stdout).status).toBe("completed");

    const shown = await runCli(cwd, ["show", sessionId, "--json"]);
    const session = JSON.parse(shown.stdout) as {
      events: Array<{ type: string; content?: string }>;
    };
    const toolCalls = session.events.filter((event) => event.type === "tool.call");
    const toolResults = session.events.filter((event) => event.type === "tool.result");

    // Replay invariant: the interrupted call was recorded once and resolved
    // once — not re-issued as a fresh call.
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(session.events.filter((event) => event.type === "run.started")).toHaveLength(2);
    expect(session.events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(
      session.events.some(
        (event) => event.type === "message.assistant" && event.content === "resumed and finished"
      )
    ).toBe(true);
  },
  30_000
);

test("CLI rejects unknown flags, missing workflows, and chat to staged sessions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-cli-flags-"));

  await runCli(cwd, ["init"]);
  writeInspectWorkflow(cwd);

  const unknownFlag = await runCliRaw(cwd, ["run", "inspect", "--nope"]);
  expect(unknownFlag.exitCode).toBe(1);
  expect(unknownFlag.stderr).toContain("Unknown flag: --nope");

  const missingWorkflow = await runCliRaw(cwd, ["run", "does-not-exist"]);
  expect(missingWorkflow.exitCode).toBe(1);
  expect(missingWorkflow.stderr).toContain('No workflow named "does-not-exist"');

  const noArgs = await runCliRaw(cwd, ["run"]);
  expect(noArgs.exitCode).toBe(1);
  expect(noArgs.stderr).toContain("Usage: oma run");

  const badFlagValue = await runCliRaw(cwd, ["run", "inspect", "--max-steps", "zero"]);
  expect(badFlagValue.exitCode).toBe(1);
  expect(badFlagValue.stderr).toContain("Invalid number");

  // Chat to a staged parent is rejected with a pointer to the real controls.
  const staged = await runCli(cwd, [
    "run",
    resolve("examples/issue-to-pr-demo/workflow.yml"),
    "--input",
    "issue=1",
    "--json"
  ]);
  const stagedId = JSON.parse(staged.stdout).route.sessionId as string;
  const chat = await runCliRaw(cwd, ["send", stagedId, "hello"]);
  expect(chat.exitCode).toBe(1);
  expect(chat.stderr).toContain("oma approve/deny");
}, 30_000);

async function runCli(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await runCliRaw(cwd, args);

  if (result.exitCode !== 0) {
    throw new Error(`CLI failed: ${result.stderr || result.stdout}`);
  }

  return result;
}

async function runCliRaw(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  return { stdout, stderr, exitCode };
}
