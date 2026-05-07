import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { artifacts, harnesses, objective, run, sessions } from "@oma/runtime";
import { localEnvironment } from "../src";

async function workspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "oma-local-"));
}

test("local environment declares capabilities without claiming a security boundary", async () => {
  const environment = localEnvironment({
    workspace: await workspace(),
  });

  expect(environment.capabilities).toEqual({
    filesystem: true,
    git: true,
    securityBoundary: false,
    shell: true,
  });
});

test("shell command success emits start output and exit events", async () => {
  const session = sessions.ephemeral();

  const outcome = await run({
    objective: objective({
      goal: "Run a command",
    }),
    process: {
      session,
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "console.log('hello')"],
        });

        return {
          artifacts: [artifacts.log("command.log", result?.stdout ?? "")],
        };
      }),
    },
    environment: localEnvironment({
      workspace: await workspace(),
    }),
  });

  expect(outcome.artifacts[0]?.content).toContain("hello");
  expect(outcome.events.map((event) => event.type)).toContain("environment.command.started");
  expect(outcome.events.map((event) => event.type)).toContain("environment.command.output");
  expect(outcome.events.map((event) => event.type)).toContain("environment.command.exited");
});

test("shell command failure returns a nonzero exit code", async () => {
  let exitCode: number | null | undefined;

  await run({
    objective: objective({
      goal: "Run a failing command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
        });
        exitCode = result?.exitCode;

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: await workspace(),
    }),
  });

  expect(exitCode).toBe(7);
});

test("shell command timeout emits a timeout event and marks the result", async () => {
  let timedOut = false;

  const outcome = await run({
    objective: objective({
      goal: "Run a timed out command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 1000)"],
          timeoutMs: 20,
        });
        timedOut = result?.timedOut ?? false;

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: await workspace(),
    }),
  });

  expect(timedOut).toBe(true);
  expect(outcome.events.map((event) => event.type)).toContain("environment.command.timed_out");
});

test("shell command timeout escalates when child ignores SIGTERM", async () => {
  let timedOut = false;

  await run({
    objective: objective({
      goal: "Kill a stubborn command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          timeoutMs: 20,
        });
        timedOut = result?.timedOut ?? false;

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      killGraceMs: 20,
      workspace: await workspace(),
    }),
  });

  expect(timedOut).toBe(true);
});

test("shell output is truncated and marked", async () => {
  let stdout = "";
  let truncated = false;

  const outcome = await run({
    objective: objective({
      goal: "Run a loud command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "console.log('abcdef')"],
        });
        stdout = result?.stdout ?? "";
        truncated = result?.truncated.stdout ?? false;

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      maxOutputBytes: 3,
      workspace: await workspace(),
    }),
  });

  expect(stdout).toBe("abc");
  expect(truncated).toBe(true);
  const outputEvent = outcome.events.find((event) => event.type === "environment.command.output");
  expect(outputEvent?.type).toBe("environment.command.output");
  if (outputEvent?.type === "environment.command.output") {
    expect(outputEvent.data.truncated).toBe(true);
  }
});

test("shell output is bounded while streaming", async () => {
  let stdout = "";
  let truncated = false;

  await run({
    objective: objective({
      goal: "Run a very loud command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec({
          command: process.execPath,
          args: ["-e", "process.stdout.write('x'.repeat(100000))"],
        });
        stdout = result?.stdout ?? "";
        truncated = result?.truncated.stdout ?? false;

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      maxOutputBytes: 128,
      workspace: await workspace(),
    }),
  });

  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(128);
  expect(truncated).toBe(true);
});

test("shell command supports stdin and output observers", async () => {
  let stdout = "";
  let observed = "";

  await run({
    objective: objective({
      goal: "Run an observed command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        const result = await environment.shell?.exec(
          {
            command: process.execPath,
            args: ["-e", "process.stdin.pipe(process.stdout)"],
            stdin: "hello from stdin",
          },
          {
            stdout(chunk) {
              observed += chunk;
            },
          },
        );
        stdout = result?.stdout ?? "";

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: await workspace(),
    }),
  });

  expect(stdout).toBe("hello from stdin");
  expect(observed).toBe("hello from stdin");
});

test("filesystem read and write are scoped to the workspace", async () => {
  const dir = await workspace();
  let readBack = "";

  await run({
    objective: objective({
      goal: "Use scoped filesystem",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        await environment.filesystem?.writeText("notes/result.md", "Done.");
        readBack = (await environment.filesystem?.readText("notes/result.md")) ?? "";

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: dir,
    }),
  });

  expect(readBack).toBe("Done.");
  expect(await readFile(join(dir, "notes/result.md"), "utf8")).toBe("Done.");
});

test("filesystem rejects path escapes", async () => {
  let message = "";

  await run({
    objective: objective({
      goal: "Reject path escape",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        try {
          await environment.filesystem?.writeText("../outside.txt", "no");
        } catch (error) {
          message = error instanceof Error ? error.message : "";
        }

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: await workspace(),
    }),
  });

  expect(message).toContain("escapes workspace");
});

test("git status reports dirty workspace state", async () => {
  if (spawnSync("git", ["--version"]).status !== 0) {
    return;
  }

  const dir = await workspace();
  spawnSync("git", ["init"], { cwd: dir });
  let clean = true;
  let short = "";

  await run({
    objective: objective({
      goal: "Read git status",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        await environment.filesystem?.writeText("dirty.txt", "dirty");
        const status = await environment.git?.status();
        clean = status?.clean ?? true;
        short = status?.short ?? "";

        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: dir,
    }),
  });

  expect(clean).toBe(false);
  expect(short).toContain("dirty.txt");
});
