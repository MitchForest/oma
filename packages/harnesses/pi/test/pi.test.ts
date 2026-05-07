import { expect, test } from "bun:test";
import { environments, harnesses, objective, run, sessions } from "@oma/runtime";
import type {
  BoundEnvironment,
  CommandObserver,
  CommandResult,
  Environment,
  ShellCapability,
} from "@oma/runtime";
import { parsePiJsonl, piHarness, renderPiObjective, runPiProcess } from "../src";

function commandResult(input: Partial<CommandResult> = {}): CommandResult {
  return {
    args: input.args ?? [],
    command: input.command ?? "pi",
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

test("renderPiObjective includes goal constraints success and expected report", () => {
  const rendered = renderPiObjective(
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

test("parsePiJsonl ignores malformed non-protocol lines", () => {
  expect(parsePiJsonl('{"type":"agent_start"}\nnot json\n{"type":"agent_end"}\n')).toEqual([
    {
      type: "agent_start",
    },
    {
      type: "agent_end",
    },
  ]);
});

test("runPiProcess requires shell capability", async () => {
  await expect(
    runPiProcess({
      environment: environments.none().bind({
        runId: "run_test",
        session: sessions.ephemeral(),
      }),
      executable: "pi",
      args: ["--mode", "json", "test"],
    }),
  ).rejects.toThrow("shell capability");
});

test("piHarness returns report events and normalized observations from a mocked process", async () => {
  let executedArgs: string[] = [];
  const session = sessions.ephemeral();
  const outcome = await run({
    objective: objective({
      goal: "Write a report",
    }),
    process: {
      session,
      harness: piHarness({
        executable: "pi",
        includePatch: false,
      }),
    },
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        executedArgs = args;
        const events = [
          '{"type":"session","id":"pi-session"}',
          '{"type":"agent_start"}',
          '{"type":"tool_execution_start","toolName":"bash"}',
          '{"type":"tool_execution_end","toolName":"bash","isError":false}',
          '{"type":"message_end"}',
          '{"type":"agent_end"}',
        ].join("\n");
        observer?.stdout?.(`${events}\n`);
        files.set(".oma/pi-report.md", "Report body");
        return commandResult({
          args,
          stdout: events,
        });
      },
    }),
  });

  expect(outcome.status).toBe("succeeded");
  expect(executedArgs.slice(0, 3)).toEqual(["--mode", "json", "--no-session"]);
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

test("piHarness returns patch artifacts when git diff is nonempty", async () => {
  const observationSession = sessions.ephemeral();

  const result = await piHarness().run({
    runId: "run_test",
    objective: objective({
      goal: "Change code",
    }),
    session: sessions.ephemeral(),
    observe: async () =>
      await observationSession.append({
        runId: "run_test",
        type: "harness.observed",
        at: new Date().toISOString(),
        data: {
          harnessId: "pi",
          kind: "state",
        },
      }),
    environment: fakeEnvironment({
      diff: "diff --git a/a b/a\n",
      onExec(_args, files, observer) {
        observer?.stdout?.('{"type":"agent_end"}\n');
        files.set(".oma/pi-report.md", "Report body");
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

test("piHarness fails on nonzero exit and run converts it to failed outcome", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Fail",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: piHarness({
        executable: "pi",
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

test("piHarness is swappable with mock and codex-shaped harnesses in the same run shape", async () => {
  const base = {
    objective: objective({
      goal: "Swap harness",
    }),
    environment: fakeEnvironment({
      onExec(args, files, observer) {
        observer?.stdout?.('{"type":"agent_end"}\n');
        files.set(".oma/pi-report.md", "Swapped harness report");
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

  const pi = await run({
    ...base,
    process: {
      session: sessions.ephemeral(),
      harness: piHarness({
        executable: "pi",
        includePatch: false,
      }),
    },
  });

  expect(mocked.status).toBe("succeeded");
  expect(pi.status).toBe("succeeded");
});
