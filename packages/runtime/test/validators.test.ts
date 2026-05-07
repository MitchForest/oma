import { expect, test } from "bun:test";
import { artifacts, environments, objective, sessions, validators } from "../src";

test("artifactExists passes when every required artifact exists", async () => {
  const validator = validators.artifactExists(["a.md", "b.md"]);

  const result = await validator.validate({
    objective: objective({
      goal: "Test",
    }),
    artifacts: [artifacts.report("a.md", "A"), artifacts.report("b.md", "B")],
    environment: environments.none(),
    session: sessions.ephemeral(),
  });

  expect(result.status).toBe("passed");
});

test("artifactExists fails with evidence when an artifact is missing", async () => {
  const validator = validators.artifactExists(["a.md", "b.md"]);

  const result = await validator.validate({
    objective: objective({
      goal: "Test",
    }),
    artifacts: [artifacts.report("a.md", "A")],
    environment: environments.none(),
    session: sessions.ephemeral(),
  });

  expect(result.status).toBe("failed");
  expect(result.evidence[0]?.kind).toBe("artifact");
  if (result.evidence[0]?.kind === "artifact") {
    expect(result.evidence[0].message).toContain("b.md");
  }
});
