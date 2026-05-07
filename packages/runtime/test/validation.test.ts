import { expect, test } from "bun:test";
import { artifacts, environments, sessions, validateArtifacts, validators } from "@oma/runtime";

test("validateArtifacts reruns validators without a harness", async () => {
  const session = sessions.ephemeral();
  const environment = environments.none().bind({
    runId: "run_validate",
    session,
  });

  const results = await validateArtifacts({
    objective: {
      goal: "Validate artifacts",
      constraints: [],
      success: ["report.md exists"],
    },
    artifacts: [artifacts.report("report.md", "Done.")],
    environment,
    session,
    validators: [validators.artifactExists("report.md")],
  });

  expect(results).toEqual([
    expect.objectContaining({
      status: "passed",
      validatorId: "artifact.exists:report.md",
    }),
  ]);
  expect(await session.events()).toEqual([]);
});
