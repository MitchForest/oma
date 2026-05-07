import { expect, test } from "bun:test";
import { artifacts, environments, harnesses, objective, run, sessions, validators } from "../src";

test("run returns a succeeded outcome when required artifacts exist", async () => {
  const session = sessions.ephemeral();
  const report = artifacts.report("result.md", "Done.");

  const outcome = await run({
    objective: objective({
      goal: "Produce a report",
      constraints: ["Do not mutate external systems"],
      success: ["A report artifact exists"],
    }),
    process: {
      session,
      harness: harnesses.mock({
        artifacts: [report],
      }),
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(outcome.status).toBe("succeeded");
  expect(outcome.artifacts).toEqual([report]);
  expect(outcome.validation).toHaveLength(1);
  expect(outcome.validation[0]?.status).toBe("passed");
});

test("run returns a failed outcome with evidence when required artifacts are missing", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Produce a report",
      success: ["A report artifact exists"],
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock(),
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.validation).toHaveLength(1);
  expect(outcome.validation[0]?.status).toBe("failed");
  const evidence = outcome.validation[0]?.evidence[0];
  expect(evidence?.kind).toBe("artifact");
  if (evidence?.kind === "artifact") {
    expect(evidence.message).toContain("Missing required artifact");
  }
});

test("run returns an inconclusive outcome when any validator is inconclusive", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock({
        artifacts: [artifacts.report("result.md", "Done.")],
      }),
    },
    environment: environments.none(),
    validation: [
      validators.artifactExists("result.md"),
      validators.inconclusive("manual-review", "A human review is still required."),
    ],
  });

  expect(outcome.status).toBe("inconclusive");
  expect(outcome.validation.map((result) => result.status)).toEqual(["passed", "inconclusive"]);
});

test("run emits ordered events through the session", async () => {
  const session = sessions.ephemeral();

  const outcome = await run({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session,
      harness: harnesses.mock({
        artifacts: [artifacts.report("result.md", "Done.")],
      }),
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(outcome.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(outcome.events.map((event) => event.type)).toEqual([
    "run.started",
    "harness.started",
    "harness.completed",
    "artifact.produced",
    "validation.started",
    "validation.completed",
    "run.completed",
  ]);
  expect(await session.events()).toEqual(outcome.events);
});

test("run ids are collision resistant and not sequential counters", async () => {
  const first = await run({
    objective: objective({
      goal: "First",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock(),
    },
    environment: environments.none(),
  });
  const second = await run({
    objective: objective({
      goal: "Second",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock(),
    },
    environment: environments.none(),
  });

  expect(first.runId).not.toBe(second.runId);
  expect(first.runId).toMatch(/^run_[0-9a-f]{32}$/);
  expect(first.runId).not.toBe("run_1");
});

test("validator exceptions produce terminal failed outcomes", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Validate safely",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.mock({
        artifacts: [artifacts.report("result.md", "Done.")],
      }),
    },
    environment: environments.none(),
    validation: [
      {
        id: "throws",
        async validate() {
          throw new Error("validator exploded");
        },
      },
    ],
  });

  expect(outcome.status).toBe("failed");
  expect(outcome.validation[0]?.status).toBe("failed");
  expect(outcome.events.map((event) => event.type)).toContain("validation.completed");
  expect(outcome.events.at(-1)?.type).toBe("run.completed");
});
