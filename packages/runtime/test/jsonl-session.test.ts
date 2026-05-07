import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  artifacts,
  environments,
  harnesses,
  objective,
  replayOutcome,
  run,
  sessions,
  validators,
} from "../src";

test("jsonl sessions survive a new store instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-jsonl-"));
  const firstStore = sessions.jsonl({ dir });
  const session = await firstStore.create({ id: "session_test" });

  await run({
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

  const secondStore = sessions.jsonl({ dir });
  const reopened = await secondStore.open("session_test");
  const replayed = await replayOutcome(reopened);

  expect(replayed.ok).toBe(true);
  if (replayed.ok) {
    expect(replayed.outcome.status).toBe("succeeded");
    expect(replayed.outcome.artifacts[0]?.name).toBe("result.md");
  }
});

test("sessions can be exported to jsonl and imported into a new store", async () => {
  const session = sessions.ephemeral();

  await run({
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

  const exported = await sessions.exportJsonl(session);
  const imported = await sessions.importJsonl(sessions.memory(), exported, {
    id: "imported_session",
  });
  const replayed = await replayOutcome(imported);

  expect(replayed.ok).toBe(true);
  if (replayed.ok) {
    expect(replayed.outcome.status).toBe("succeeded");
    expect(replayed.outcome.artifacts[0]?.name).toBe("result.md");
  }
});

test("jsonl store appends events and returns real createdAt summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-jsonl-append-"));
  const store = sessions.jsonl({ dir });
  const session = await store.create({ id: "append_session" });

  await Promise.all([
    session.append({
      runId: "run_append",
      type: "harness.started",
      at: "2026-05-07T00:00:00.000Z",
      data: {},
    }),
    session.append({
      runId: "run_append",
      type: "harness.completed",
      at: "2026-05-07T00:00:01.000Z",
      data: {
        artifactCount: 0,
      },
    }),
  ]);

  const reopened = await store.open("append_session");
  const events = await reopened.events();
  const summaries = await store.list?.();

  expect(events).toHaveLength(2);
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(summaries?.[0]?.createdAt).not.toBe("unknown");
});
