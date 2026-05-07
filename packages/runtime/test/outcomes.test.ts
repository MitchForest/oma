import { expect, test } from "bun:test";
import { artifacts, objective, outcomes, run, sessions, validators } from "../src";

test("outcome json is stable and does not include artifact content", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Serialize outcome",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: {
        async run() {
          return {
            artifacts: [artifacts.report("result.md", "Done.")],
          };
        },
      },
    },
    environment: {
      kind: "test",
      capabilities: {
        securityBoundary: false,
      },
      bind() {
        return {
          kind: "test",
          capabilities: {
            securityBoundary: false,
          },
        };
      },
    },
    validation: [validators.artifactExists("result.md")],
  });

  const json = outcomes.toJson(outcome);

  expect(json.schemaVersion).toBe(1);
  expect(json.status).toBe("succeeded");
  expect(json.artifacts[0]?.name).toBe("result.md");
  expect("content" in (json.artifacts[0] ?? {})).toBe(false);
});

test("outcome markdown includes status artifacts and validation", async () => {
  const outcome = await run({
    objective: objective({
      goal: "Serialize outcome",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: {
        async run() {
          return {
            artifacts: [artifacts.report("result.md", "Done.")],
          };
        },
      },
    },
    environment: {
      kind: "test",
      capabilities: {
        securityBoundary: false,
      },
      bind() {
        return {
          kind: "test",
          capabilities: {
            securityBoundary: false,
          },
        };
      },
    },
    validation: [validators.artifactExists("result.md")],
  });

  const markdown = outcomes.toMarkdown(outcome);

  expect(markdown).toContain("# OMA Outcome");
  expect(markdown).toContain("**Status:** succeeded");
  expect(markdown).toContain("**Events:**");
  expect(markdown).toContain("result.md");
  expect(markdown).toContain("artifact.exists:result.md");
});
