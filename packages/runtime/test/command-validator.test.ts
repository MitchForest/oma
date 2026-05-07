import { expect, test } from "bun:test";
import { environments, objective, run, sessions, validators } from "../src";
import type { BoundEnvironment, Environment } from "../src";

function commandEnvironment(exitCode: number, stdout = "", stderr = ""): Environment {
  return {
    kind: "command-test",
    capabilities: {
      securityBoundary: false,
      shell: true,
    },
    bind(): BoundEnvironment {
      return {
        kind: "command-test",
        capabilities: {
          securityBoundary: false,
          shell: true,
        },
        shell: {
          async exec(input) {
            return {
              command: input.command,
              args: input.args ?? [],
              cwd: "/workspace",
              durationMs: 12,
              exitCode,
              stderr,
              stdout,
              timedOut: false,
              truncated: {
                stderr: false,
                stdout: false,
              },
            };
          },
        },
      };
    },
  };
}

test("command validator passes on zero exit code", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Validate command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: {
        async run() {
          return {
            artifacts: [],
          };
        },
      },
    },
    environment: commandEnvironment(0, "ok"),
    validation: [validators.command({ command: "test", id: "test" })],
  });

  expect(outcome.status).toBe("succeeded");
  expect(outcome.validation[0]?.evidence[0]?.kind).toBe("command");
});

test("command validator fails on nonzero exit code with command evidence", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Validate command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: {
        async run() {
          return {
            artifacts: [],
          };
        },
      },
    },
    environment: commandEnvironment(2, "", "bad"),
    validation: [validators.command({ command: "test", id: "test" })],
  });

  expect(outcome.status).toBe("failed");
  const evidence = outcome.validation[0]?.evidence[0];
  expect(evidence?.kind).toBe("command");
  if (evidence?.kind === "command") {
    expect(evidence.exitCode).toBe(2);
    expect(evidence.stderr).toBe("bad");
    expect(evidence.durationMs).toBe(12);
  }
});

test("command validator fails when shell capability is missing", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Validate command",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: {
        async run() {
          return {
            artifacts: [],
          };
        },
      },
    },
    environment: environments.none(),
    validation: [validators.command({ command: "test", id: "test" })],
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.validation[0]?.evidence[0]?.kind).toBe("text");
});
