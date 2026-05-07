import { expect, test } from "bun:test";
import { artifacts, environments, harnesses, objective, run, sessions } from "@oma/runtime";

test("run can use a caller-provided run id", async () => {
  const outcome = await run(
    {
      objective: objective({ goal: "Use the supplied id" }),
      process: {
        session: sessions.ephemeral(),
        harness: harnesses.mock({
          artifacts: [artifacts.report("report.md", "Done.")],
        }),
      },
      environment: environments.none(),
    },
    {
      runId: "run_supplied",
    },
  );

  expect(outcome.runId).toBe("run_supplied");
  expect(outcome.events.every((event) => event.runId === "run_supplied")).toBe(true);
});
