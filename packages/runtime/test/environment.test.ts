import { expect, test } from "bun:test";
import { artifacts, environments, harnesses, objective, run, sessions } from "../src";

test("run passes a bound environment to the harness", async () => {
  let observedRunId = "";
  let observedKind = "";
  let observedSecurityBoundary: unknown;

  const outcome = await run({
    objective: objective({
      goal: "Observe the environment",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment, observe, runId }) => {
        observedRunId = runId;
        observedKind = environment.kind;
        observedSecurityBoundary = environment.capabilities.securityBoundary;
        await observe({
          kind: "state",
          label: "environment",
          status: "completed",
          summary: environment.kind,
        });

        return {
          artifacts: [artifacts.report("result.md", "Done.")],
        };
      }),
    },
    environment: environments.none(),
  });

  expect(outcome.status).toBe("succeeded");
  expect(observedRunId).toBe(outcome.runId);
  expect(observedKind).toBe("none");
  expect(observedSecurityBoundary).toBe(false);
  const observed = outcome.events.find((event) => event.type === "harness.observed");
  expect(observed?.type).toBe("harness.observed");
  if (observed?.type === "harness.observed") {
    expect(observed.data.harnessId).toBe("custom");
    expect(observed.data.kind).toBe("state");
    expect(observed.data.summary).toBe("none");
  }
});

test("replay accepts environment and harness observation events as known events", async () => {
  const session = sessions.ephemeral();

  await session.append({
    runId: "run_test",
    type: "environment.command.started",
    at: "2026-05-07T00:00:00.000Z",
    data: {
      command: "echo",
      args: ["hello"],
      cwd: "/tmp",
      timeoutMs: 30_000,
    },
  });
  await session.append({
    runId: "run_test",
    type: "harness.observed",
    at: "2026-05-07T00:00:01.000Z",
    data: {
      harnessId: "test",
      kind: "message",
      status: "completed",
      summary: "Done",
    },
  });

  const outcome = await import("../src/replay");
  const projection = await outcome.replay(session);

  expect(projection.diagnostics).toEqual([]);
});
