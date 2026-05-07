import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  artifacts,
  environments,
  harnesses,
  objective,
  resume,
  run,
  sessions,
  validators,
} from "../src";
import type { Harness } from "../src";

test("resume returns a terminal session without calling the harness", async () => {
  const session = sessions.ephemeral();
  let harnessCalls = 0;

  const harness: Harness = {
    async run() {
      harnessCalls += 1;
      return {
        artifacts: [artifacts.report("result.md", "Done.")],
      };
    },
  };

  await run({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session,
      harness,
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  const resumed = await resume({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session,
      harness,
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(harnessCalls).toBe(1);
  expect(resumed.status).toBe("succeeded");
});

test("resume continues a session stopped after artifacts without rerunning the harness", async () => {
  const session = sessions.ephemeral();
  let harnessCalls = 0;

  const harness: Harness = {
    async run() {
      harnessCalls += 1;
      return {
        artifacts: [artifacts.report("result.md", "Done.")],
      };
    },
  };

  await run(
    {
      objective: objective({
        goal: "Produce a report",
      }),
      process: {
        session,
        harness,
      },
      environment: environments.none(),
      validation: [validators.artifactExists("result.md")],
    },
    {
      stopAfter: "artifacts.produced",
    },
  );

  const resumed = await resume({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session,
      harness,
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(harnessCalls).toBe(1);
  expect(resumed.status).toBe("succeeded");
  expect(resumed.validation[0]?.status).toBe("passed");
});

test("resume can continue a stopped jsonl session opened by session id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-resume-"));
  const store = sessions.jsonl({ dir });
  const session = await store.create({ id: "resume_session" });

  await run(
    {
      objective: objective({
        goal: "Produce a report",
      }),
      process: {
        session,
        harness: {
          async run() {
            return {
              artifacts: [artifacts.report("result.md", "Done.")],
            };
          },
        },
      },
      environment: environments.none(),
      validation: [validators.artifactExists("result.md")],
    },
    {
      stopAfter: "run.started",
    },
  );

  const reopened = await sessions.jsonl({ dir }).open("resume_session");
  const resumed = await resume({
    objective: objective({
      goal: "Produce a report",
    }),
    process: {
      session: reopened,
      harness: {
        async run() {
          return {
            artifacts: [artifacts.report("result.md", "Done.")],
          };
        },
      },
    },
    environment: environments.none(),
    validation: [validators.artifactExists("result.md")],
  });

  expect(resumed.status).toBe("succeeded");
  expect(resumed.events[0]?.sessionId).toBe("resume_session");
});

test("resume does not rerun a harness that completed with zero artifacts", async () => {
  const session = sessions.ephemeral();
  let harnessCalls = 0;

  await run({
    objective: objective({
      goal: "Produce no artifacts",
    }),
    process: {
      session,
      harness: {
        async run() {
          harnessCalls += 1;
          return {
            artifacts: [],
          };
        },
      },
    },
    environment: environments.none(),
  });

  const resumed = await resume({
    objective: objective({
      goal: "Produce no artifacts",
    }),
    process: {
      session,
      harness: {
        async run() {
          harnessCalls += 1;
          return {
            artifacts: [],
          };
        },
      },
    },
    environment: environments.none(),
  });

  expect(harnessCalls).toBe(1);
  expect(resumed.status).toBe("succeeded");
});

test("resume converts validator exceptions into terminal failed outcomes", async () => {
  const session = sessions.ephemeral();

  await run(
    {
      objective: objective({
        goal: "Stop before validation",
      }),
      process: {
        session,
        harness: harnesses.mock({
          artifacts: [artifacts.report("result.md", "Done.")],
        }),
      },
      environment: environments.none(),
    },
    {
      stopAfter: "artifacts.produced",
    },
  );

  const outcome = await resume({
    objective: objective({
      goal: "Stop before validation",
    }),
    process: {
      session,
      harness: harnesses.mock(),
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
  expect(outcome.events.at(-1)?.type).toBe("run.completed");
});
