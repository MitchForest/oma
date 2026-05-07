import { expect, test } from "bun:test";
import {
  artifacts,
  environments,
  harnesses,
  objective,
  replay,
  replayOutcome,
  run,
  sessions,
  validators,
} from "../src";
import type { Harness } from "../src";

test("replay reconstructs a terminal outcome without calling a harness", async () => {
  const session = sessions.ephemeral();

  const original = await run({
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

  const explodingHarness: Harness = {
    async run() {
      throw new Error("Replay should not call a harness.");
    },
  };
  expect(explodingHarness).toBeDefined();

  const replayed = await replayOutcome(session);

  expect(replayed.ok).toBe(true);
  if (replayed.ok) {
    expect(replayed.outcome.status).toBe("succeeded");
    expect(replayed.outcome.runId).toBe(original.runId);
    expect(replayed.outcome.artifacts).toEqual(original.artifacts);
  }
});

test("replay returns diagnostics for unknown event types and unsupported schema versions", async () => {
  const session = sessions.ephemeral();

  await session.append({
    runId: "run_bad",
    type: "run.started",
    at: "2026-05-07T00:00:00.000Z",
    data: {
      objective: objective({
        goal: "Test",
      }),
    },
  });

  const events = await session.events();
  events.push({
    schemaVersion: 99,
    id: "event_bad",
    sessionId: session.id,
    runId: "run_bad",
    sequence: 3,
    type: "strange.event",
    at: "2026-05-07T00:00:01.000Z",
    data: {},
  });

  const imported = await sessions.importJsonl(
    sessions.memory(),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const projection = await replay(imported);
  const outcome = await replayOutcome(imported);

  expect(projection.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "schema_version_unsupported",
  );
  expect(projection.diagnostics.map((diagnostic) => diagnostic.code)).toContain("sequence_gap");
  expect(projection.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "unknown_event_type",
  );
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("not_terminal");
  }
});

test("replayOutcome rejects terminal sessions with structural diagnostics", async () => {
  const session = sessions.ephemeral();
  const runId = "run_bad";

  await session.append({
    runId,
    type: "run.started",
    at: "2026-05-07T00:00:00.000Z",
    data: {
      objective: objective({
        goal: "Test",
      }),
    },
  });

  const events = await session.events();
  events.push({
    schemaVersion: 99,
    id: "event_bad",
    sessionId: session.id,
    runId,
    sequence: 2,
    type: "run.completed",
    at: "2026-05-07T00:00:01.000Z",
    data: {
      status: "succeeded",
    },
  });

  const imported = await sessions.importJsonl(
    sessions.memory(),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  const outcome = await replayOutcome(imported);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe("invalid_session");
  }
});
