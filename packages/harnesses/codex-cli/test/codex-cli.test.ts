import { expect, test } from "bun:test";
import { environments, harnesses, objective, run, sessions } from "@oma/runtime";
import type {
  BoundEnvironment,
  CommandResult,
  Environment,
  HarnessObservedEvent,
  HarnessObservationInput,
} from "@oma/runtime";
import { codexCliHarness, renderCodexObjective, runHarnessProcess } from "../src";

function commandResult(input: Partial<CommandResult> = {}): CommandResult {
  return {
    args: input.args ?? [],
    command: input.command ?? "codex",
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
    onExec?: (args: string[], files: Map<string, string>) => CommandResult | Promise<CommandResult>;
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
        shell: {
          async exec({ args, command, timeoutMs }) {
            const result = input.onExec
              ? await input.onExec(args ?? [], files)
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
        },
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
        harnessId: "test",
        ...observation,
      },
    });
}

test("renderCodexObjective includes goal constraints success and expected report", () => {
  const rendered = renderCodexObjective(
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
  expect(rendered).toContain("OMA validators run after the harness");
});

test("runHarnessProcess requires shell capability", async () => {
  await expect(
    runHarnessProcess({
      environment: environments.none().bind({
        runId: "run_test",
        session: sessions.ephemeral(),
      }),
      executable: "codex",
      args: ["exec", "test"],
    }),
  ).rejects.toThrow("shell capability");
});

test("codexCliHarness returns report and log artifacts from a mocked process", async () => {
  let executedArgs: string[] = [];
  const harness = codexCliHarness({
    executable: "codex",
    includePatch: false,
    skipGitRepoCheck: true,
  });

  const result = await harness.run({
    runId: "run_test",
    objective: objective({
      goal: "Write a report",
    }),
    session: sessions.ephemeral(),
    observe: testObserver(),
    environment: fakeEnvironment({
      onExec(args, files) {
        executedArgs = args;
        files.set(".oma/codex-report.md", "Report body");
        return commandResult({
          args,
          stdout: "codex log",
        });
      },
    }).bind({
      runId: "run_test",
      session: sessions.ephemeral(),
    }),
  });

  expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "log"]);
  expect(result.artifacts[0]?.content).toBe("Report body");
  expect(executedArgs).toContain("--skip-git-repo-check");
});

test("codexCliHarness returns patch artifacts when git diff is nonempty", async () => {
  const harness = codexCliHarness();

  const result = await harness.run({
    runId: "run_test",
    objective: objective({
      goal: "Change code",
    }),
    session: sessions.ephemeral(),
    observe: testObserver(),
    environment: fakeEnvironment({
      diff: "diff --git a/a b/a\n",
      onExec(_args, files) {
        files.set(".oma/codex-report.md", "Report body");
        return commandResult();
      },
    }).bind({
      runId: "run_test",
      session: sessions.ephemeral(),
    }),
  });

  expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "patch"]);
  expect(result.artifacts[1]?.name).toBe("changes.patch");
});

test("codexCliHarness fails on nonzero exit and run converts it to failed outcome", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Fail",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: codexCliHarness({
        executable: "codex",
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

test("codexCliHarness fails on timeout and leaves session terminal", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Timeout",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: codexCliHarness({
        executable: "codex",
      }),
    },
    environment: fakeEnvironment({
      onExec(args) {
        return commandResult({
          args,
          exitCode: null,
          timedOut: true,
        });
      },
    }),
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.events.at(-1)?.type).toBe("run.failed");
});

test("codexCliHarness is swappable with mock harness in the same run shape", async () => {
  const base = {
    objective: objective({
      goal: "Swap harness",
    }),
    environment: fakeEnvironment({
      onExec(args, files) {
        files.set(".oma/codex-report.md", "Swapped harness report");
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

  const codex = await run({
    ...base,
    process: {
      session: sessions.ephemeral(),
      harness: codexCliHarness({
        executable: "codex",
        includePatch: false,
      }),
    },
  });

  expect(mocked.status).toBe("succeeded");
  expect(codex.status).toBe("succeeded");
});
