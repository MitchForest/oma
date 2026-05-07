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
  validators,
} from "@oma/runtime";
import { sqliteSessions } from "../src";

test("sqlite sessions survive a new store instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-sqlite-"));
  const path = join(dir, "sessions.db");
  const firstStore = sqliteSessions({ path });
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

  const secondStore = sqliteSessions({ path });
  const reopened = await secondStore.open("session_test");
  const replayed = await replayOutcome(reopened);

  expect(replayed.ok).toBe(true);
  if (replayed.ok) {
    expect(replayed.outcome.status).toBe("succeeded");
    expect(replayed.outcome.artifacts[0]?.name).toBe("result.md");
  }
});
