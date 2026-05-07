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
  opencodeHarness,
  opencodeObservation,
  parseOpencodeJsonl,
  renderOpencodeObjective,
  runOpencodeProcess,
} from "../src";

function commandResult(input: Partial<CommandResult> = {}): CommandResult {
  return {
    args: input.args ?? [],
    command: input.command ?? "opencode",
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
        async exec({ args, command, timeoutMs }, observer) {
          const result = input.onExec
            ? await input.onExec(args ?? [], files, observer)
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
        harnessId: "opencode",
        ...observation,
      },
    });
}

test("renderOpencodeObjective includes goal constraints success and expected report", () => {
  const rendered = renderOpencodeObjective(
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

test("parseOpencodeJsonl ignores malformed non-protocol lines", () => {
  expect(
    parseOpencodeJsonl('{"type":"session.start"}\nnot json\n{"type":"session.end"}\n'),
  ).toEqual([
    {
      type: "session.start",
    },
    {
      type: "session.end",
    },
  ]);
});

test("opencodeObservation maps common event families conservatively", () => {
  expect(
    opencodeObservation({
      toolName: "bash",
      type: "tool.execution.completed",
    }),
  ).toEqual({
    kind: "tool",
    label: "bash",
    status: "completed",
  });
  expect(
    opencodeObservation({
      message: "cost recorded",
      type: "usage.updated",
    }),
  ).toEqual({
    kind: "usage",
    status: "updated",
    summary: "cost recorded",
  });
  expect(
    opencodeObservation({
      type: "unrelated.event",
    }),
  ).toBeUndefined();
});

test("runOpencodeProcess requires shell capability", async () => {
  await expect(
    runOpencodeProcess({
      environment: environments.none().bind({
        runId: "run_test",
        session: sessions.ephemeral(),
      }),
      executable: "opencode",
      args: ["run", "--format", "json", "test"],
    }),
  ).rejects.toThrow("shell capability");
});

test("opencodeHarness returns report events and normalized observations from a mocked process", async () => {
  let executedArgs: string[] = [];
  const outcome = await run({
    objective: objective({
      goal: "Write a report",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: opencodeHarness({
        agent: "build",
        executable: "opencode",
        includePatch: false,
        model: "anthropic/claude-sonnet-4-5",
        pure: true,
      }),
    },
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        executedArgs = args;
        const events = [
          '{"type":"session.start","id":"ses_test"}',
          '{"type":"message.start"}',
          '{"type":"tool.execution.started","toolName":"bash"}',
          '{"type":"tool.execution.completed","toolName":"bash"}',
          '{"type":"usage.updated","message":"tokens"}',
          '{"type":"message.completed"}',
        ].join("\n");
        observer?.stdout?.(`${events}\n`);
        files.set(".oma/opencode-report.md", "Report body");
        return commandResult({
          args,
          stdout: events,
        });
      },
    }),
  });

  expect(outcome.status).toBe("succeeded");
  expect(executedArgs.slice(0, 3)).toEqual(["run", "--format", "json"]);
  expect(executedArgs).toContain("--agent");
  expect(executedArgs).toContain("build");
  expect(executedArgs).toContain("--model");
  expect(executedArgs).toContain("anthropic/claude-sonnet-4-5");
  expect(executedArgs).toContain("--pure");
  expect(executedArgs.at(-1)).toContain("# Objective\n\nWrite a report");
  expect(outcome.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "log"]);
  expect(outcome.artifacts[0]?.content).toBe("Report body");
  const observations = outcome.events.filter((event) => event.type === "harness.observed");
  expect(observations.length).toBeGreaterThanOrEqual(5);
  expect(
    observations.some(
      (event) =>
        event.type === "harness.observed" &&
        event.data.kind === "tool" &&
        event.data.label === "bash" &&
        event.data.status === "completed",
    ),
  ).toBe(true);
});

test("opencodeHarness passes optional automation flags explicitly", async () => {
  let executedArgs: string[] = [];
  await opencodeHarness({
    attach: "http://localhost:4096",
    dangerouslySkipPermissions: true,
    dir: "/remote/project",
    files: ["README.md", "src/index.ts"],
    includePatch: false,
    title: "oma-smoke",
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
        observer?.stdout?.('{"type":"message.completed"}\n');
        files.set(".oma/opencode-report.md", "Report body");
        return commandResult({ args });
      },
    }).bind({
      runId: "run_test",
      session: sessions.ephemeral(),
    }),
  });

  expect(executedArgs).toContain("--attach");
  expect(executedArgs).toContain("http://localhost:4096");
  expect(executedArgs).toContain("--dangerously-skip-permissions");
  expect(executedArgs).toContain("--dir");
  expect(executedArgs).toContain("/remote/project");
  expect(executedArgs.filter((arg) => arg === "--file")).toHaveLength(2);
  expect(executedArgs).toContain("README.md");
  expect(executedArgs).toContain("src/index.ts");
  expect(executedArgs).toContain("--title");
  expect(executedArgs).toContain("oma-smoke");
});

test("opencodeHarness returns patch artifacts when git diff is nonempty", async () => {
  const result = await opencodeHarness().run({
    runId: "run_test",
    objective: objective({
      goal: "Change code",
    }),
    session: sessions.ephemeral(),
    observe: testObserver(),
    environment: fakeEnvironment({
      diff: "diff --git a/a b/a\n",
      onExec(_args, files, observer) {
        observer?.stdout?.('{"type":"message.completed"}\n');
        files.set(".oma/opencode-report.md", "Report body");
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

test("opencodeHarness fails on nonzero exit and run converts it to failed outcome", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Fail",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: opencodeHarness({
        executable: "opencode",
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

test("opencodeHarness is swappable with mock codex-shaped and pi-shaped harnesses", async () => {
  const base = {
    objective: objective({
      goal: "Swap harness",
    }),
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        observer?.stdout?.('{"type":"message.completed"}\n');
        files.set(".oma/opencode-report.md", "Swapped harness report");
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

  const opencode = await run({
    ...base,
    process: {
      session: sessions.ephemeral(),
      harness: opencodeHarness({
        executable: "opencode",
        includePatch: false,
      }),
    },
  });

  expect(mocked.status).toBe("succeeded");
  expect(opencode.status).toBe("succeeded");
});
