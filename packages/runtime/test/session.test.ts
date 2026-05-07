import { expect, test } from "bun:test";
import { objective, sessions } from "../src";

test("memory session appends immutable sequence numbers", async () => {
  const session = sessions.ephemeral();
  const runId = "run_test";

  const first = await session.append({
    runId,
    type: "run.started",
    at: "2026-05-07T00:00:00.000Z",
    data: {
      objective: objective({
        goal: "Test",
      }),
    },
  });

  const second = await session.append({
    runId,
    type: "harness.started",
    at: "2026-05-07T00:00:01.000Z",
    data: {},
  });

  expect(first.sequence).toBe(1);
  expect(second.sequence).toBe(2);
  expect((await session.events()).map((event) => event.id)).toEqual([first.id, second.id]);
});
