import { expect, test } from "bun:test";
import { environments, harnesses, objective, run, sessions } from "@oma/runtime";
import type {
  BoundEnvironment,
  CommandObserver,
  CommandResult,
  Environment,
  HarnessObservedEvent,
  HarnessObservationInput,
  ShellCapability,
} from "@oma/runtime";
import {
  claudeCodeHarness,
  claudeCodeObservation,
  parseClaudeCodeJsonl,
  renderClaudeCodeObjective,
  runClaudeCodeProcess,
} from "../src";

function commandResult(input: Partial<CommandResult> = {}): CommandResult {
  return {
    args: input.args ?? [],
    command: input.command ?? "claude",
    cwd: input.cwd ?? "/workspace",
    durationMs: input.durationMs ?? 1,
    exitCode: input.exitCode ?? 0,
    stderr: input.stderr ?? "",
    stdout: input.stdout ?? "",
    timedOut: input.timedOut ?? false,
    truncated: input.truncated ?? {
      stderr: false,
      stdout: false,
    },
  };
}

function fakeEnvironment(
  input: {
    diff?: string;
    onExec?: (
      args: string[],
      files: Map<string, string>,
      observer?: CommandObserver,
      stdin?: string,
    ) => CommandResult | Promise<CommandResult>;
  } = {},
): Environment {
  const files = new Map<string, string>();

  return {
    kind: "fake",
    capabilities: {
      filesystem: true,
      git: true,
      securityBoundary: false,
      shell: true,
    },
    bind(): BoundEnvironment {
      const shell: ShellCapability = {
        async exec({ args, command, stdin, timeoutMs }, observer) {
          const result = input.onExec
            ? await input.onExec(args ?? [], files, observer, stdin)
            : commandResult({
                args: args ?? [],
                command,
              });
          return {
            ...result,
            args: result.args.length > 0 ? result.args : (args ?? []),
            command: result.command || command,
            timedOut: result.timedOut || timeoutMs === -1,
          };
        },
      };

      return {
        kind: "fake",
        capabilities: {
          filesystem: true,
          git: true,
          securityBoundary: false,
          shell: true,
        },
        filesystem: {
          async list() {
            return [...files.entries()].map(([path, content]) => ({
              path,
              bytes: Buffer.byteLength(content),
            }));
          },
          async readText(path) {
            const content = files.get(path);
            if (content === undefined) {
              throw new Error(`Missing file: ${path}`);
            }
            return content;
          },
          async writeText(path, content) {
            files.set(path, content);
          },
        },
        git: {
          async diff() {
            return input.diff ?? "";
          },
          async status() {
            return {
              clean: (input.diff ?? "").length === 0,
              short: "",
            };
          },
        },
        shell,
      };
    },
  };
}

function testObserver(runId = "run_test") {
  const session = sessions.ephemeral();
  return async (observation: HarnessObservationInput) =>
    await session.append<HarnessObservedEvent>({
      runId,
      type: "harness.observed",
      at: new Date().toISOString(),
      data: {
        harnessId: "claude-code",
        ...observation,
      },
    });
}

test("renderClaudeCodeObjective includes goal constraints success and expected report", () => {
  const rendered = renderClaudeCodeObjective(
    objective({
      goal: "Fix the bug",
      constraints: ["Keep the diff small"],
      success: ["Report exists"],
    }),
    {
      reportPath: ".oma/report.md",
    },
  );

  expect(rendered).toContain("# Objective");
  expect(rendered).toContain("Fix the bug");
  expect(rendered).toContain("Keep the diff small");
  expect(rendered).toContain("Report exists");
  expect(rendered).toContain(".oma/report.md");
});

test("parseClaudeCodeJsonl ignores malformed non-protocol lines", () => {
  expect(
    parseClaudeCodeJsonl('{"type":"system","subtype":"init"}\nnot json\n{"type":"result"}\n'),
  ).toEqual([
    {
      type: "system",
      subtype: "init",
    },
    {
      type: "result",
    },
  ]);
});

test("claudeCodeObservation maps core event families conservatively", () => {
  expect(
    claudeCodeObservation({
      subtype: "init",
      type: "system",
    }),
  ).toEqual({
    kind: "state",
    label: "init",
    status: "started",
    summary: "init",
  });
  expect(
    claudeCodeObservation({
      result: "Done",
      subtype: "success",
      type: "result",
    }),
  ).toEqual({
    kind: "message",
    label: "success",
    status: "completed",
    summary: "Done",
  });
  expect(
    claudeCodeObservation({
      event: {
        content_block: {
          name: "Bash",
          type: "tool_use",
        },
        type: "content_block_start",
      },
      type: "stream_event",
    }),
  ).toEqual({
    kind: "tool",
    label: "Bash",
    status: "started",
  });
});

test("runClaudeCodeProcess requires shell capability", async () => {
  await expect(
    runClaudeCodeProcess({
      environment: environments.none().bind({
        runId: "run_test",
        session: sessions.ephemeral(),
      }),
      executable: "claude",
      args: ["-p", "--output-format", "stream-json", "test"],
    }),
  ).rejects.toThrow("shell capability");
});

test("claudeCodeHarness returns report events and normalized observations from a mocked process", async () => {
  let executedArgs: string[] = [];
  let executedStdin = "";
  const outcome = await run({
    objective: objective({
      goal: "Write a report",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: claudeCodeHarness({
        allowedTools: ["Read", "Edit"],
        bare: true,
        executable: "claude",
        includePatch: false,
        includePartialMessages: true,
        model: "sonnet",
        permissionMode: "acceptEdits",
      }),
    },
    environment: fakeEnvironment({
      onExec(args, files, observer, stdin) {
        executedArgs = args;
        executedStdin = stdin ?? "";
        const events = [
          '{"type":"system","subtype":"init"}',
          '{"type":"assistant","message":{"role":"assistant","content":[]}}',
          '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta"}}}',
          '{"type":"result","subtype":"success","result":"Done"}',
        ].join("\n");
        observer?.stdout?.(`${events}\n`);
        files.set(".oma/claude-report.md", "Report body");
        return commandResult({
          args,
          stdout: events,
        });
      },
    }),
  });

  expect(outcome.status).toBe("succeeded");
  expect(executedArgs.slice(0, 5)).toEqual([
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ]);
  expect(executedArgs).toContain("--bare");
  expect(executedArgs).toContain("--include-partial-messages");
  expect(executedArgs).toContain("--model");
  expect(executedArgs).toContain("sonnet");
  expect(executedArgs).toContain("--permission-mode");
  expect(executedArgs).toContain("acceptEdits");
  expect(executedArgs).toContain("--allowedTools");
  expect(executedArgs).toContain("Read");
  expect(executedArgs).toContain("Edit");
  expect(executedStdin).toContain("# Objective\n\nWrite a report");
  expect(outcome.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "log"]);
  expect(outcome.artifacts[0]?.content).toBe("Report body");
  const observations = outcome.events.filter((event) => event.type === "harness.observed");
  expect(observations.length).toBeGreaterThanOrEqual(4);
  expect(
    observations.some(
      (event) =>
        event.type === "harness.observed" &&
        event.data.kind === "tool" &&
        event.data.label === "Bash" &&
        event.data.status === "started",
    ),
  ).toBe(true);
});

test("claudeCodeHarness passes optional automation flags explicitly", async () => {
  let executedArgs: string[] = [];
  await claudeCodeHarness({
    addDir: ["../shared"],
    allowDangerouslySkipPermissions: true,
    dangerouslySkipPermissions: true,
    disallowedTools: ["WebSearch"],
    effort: "high",
    includeHookEvents: true,
    includePatch: false,
    maxBudgetUsd: 5,
    maxTurns: 3,
    mcpConfig: ["./mcp.json"],
    name: "oma-smoke",
    noSessionPersistence: false,
    settingSources: ["project", "local"],
    settings: '{"permissions":{}}',
    tools: ["Read", "Bash"],
  }).run({
    runId: "run_test",
    objective: objective({
      goal: "Use flags",
    }),
    session: sessions.ephemeral(),
    observe: testObserver(),
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        executedArgs = args;
        observer?.stdout?.('{"type":"result","subtype":"success"}\n');
        files.set(".oma/claude-report.md", "Report body");
        return commandResult({ args });
      },
    }).bind({
      runId: "run_test",
      session: sessions.ephemeral(),
    }),
  });

  expect(executedArgs).not.toContain("--no-session-persistence");
  expect(executedArgs).toContain("--allow-dangerously-skip-permissions");
  expect(executedArgs).toContain("--dangerously-skip-permissions");
  expect(executedArgs).toContain("--disallowedTools");
  expect(executedArgs).toContain("WebSearch");
  expect(executedArgs).toContain("--effort");
  expect(executedArgs).toContain("high");
  expect(executedArgs).toContain("--include-hook-events");
  expect(executedArgs).toContain("--max-budget-usd");
  expect(executedArgs).toContain("5");
  expect(executedArgs).toContain("--max-turns");
  expect(executedArgs).toContain("3");
  expect(executedArgs).toContain("--mcp-config");
  expect(executedArgs).toContain("./mcp.json");
  expect(executedArgs).toContain("--name");
  expect(executedArgs).toContain("oma-smoke");
  expect(executedArgs).toContain("--setting-sources");
  expect(executedArgs).toContain("project,local");
  expect(executedArgs).toContain("--settings");
  expect(executedArgs).toContain('{"permissions":{}}');
  expect(executedArgs).toContain("--tools");
  expect(executedArgs).toContain("Read");
  expect(executedArgs).toContain("Bash");
  expect(executedArgs).toContain("--add-dir");
  expect(executedArgs).toContain("../shared");
});

test("claudeCodeHarness returns patch artifacts when git diff is nonempty", async () => {
  const result = await claudeCodeHarness().run({
    runId: "run_test",
    objective: objective({
      goal: "Change code",
    }),
    session: sessions.ephemeral(),
    observe: testObserver(),
    environment: fakeEnvironment({
      diff: "diff --git a/a b/a\n",
      onExec(_args, files, observer) {
        observer?.stdout?.('{"type":"result","subtype":"success"}\n');
        files.set(".oma/claude-report.md", "Report body");
        return commandResult();
      },
    }).bind({
      runId: "run_test",
      session: sessions.ephemeral(),
    }),
  });

  expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "patch", "log"]);
  expect(result.artifacts[1]?.name).toBe("changes.patch");
});

test("claudeCodeHarness fails on nonzero exit and run converts it to failed outcome", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Fail",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: claudeCodeHarness({
        executable: "claude",
      }),
    },
    environment: fakeEnvironment({
      onExec(args) {
        return commandResult({
          args,
          exitCode: 1,
          stderr: "bad",
        });
      },
    }),
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.events.at(-1)?.type).toBe("run.failed");
});

test("claudeCodeHarness is swappable with mock codex pi and opencode shaped harnesses", async () => {
  const base = {
    objective: objective({
      goal: "Swap harness",
    }),
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        observer?.stdout?.('{"type":"result","subtype":"success"}\n');
        files.set(".oma/claude-report.md", "Swapped harness report");
        return commandResult({ args });
      },
    }),
  };

  const mocked = await run({
    ...base,
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock(),
    },
  });

  const claude = await run({
    ...base,
    process: {
      session: sessions.ephemeral(),
      harness: claudeCodeHarness({
        executable: "claude",
        includePatch: false,
      }),
    },
  });

  expect(mocked.status).toBe("succeeded");
  expect(claude.status).toBe("succeeded");
});
