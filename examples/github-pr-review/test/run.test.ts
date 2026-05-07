import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureContext, loadFixtureFindings } from "../src/fixtures";
import { runReview } from "../src/run";
import { reviewRequestFromFixture } from "../src/trigger";

describe("OMA review run", () => {
  test("produces an inspectable OMA outcome with fixture findings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "oma-pr-review-"));
    try {
      const fixtureDir = "examples/github-pr-review/fixtures/basic";
      const request = await reviewRequestFromFixture(fixtureDir);
      const context = await loadFixtureContext({ fixtureDir, request });
      const fixtureFindings = await loadFixtureFindings(fixtureDir);
      const result = await runReview({
        cwd,
        configPath: join(process.cwd(), "examples/github-pr-review/oma.config.json"),
        context,
        fixtureFindings,
      });

      expect(result.outcome.status).toBe("succeeded");
      expect(
        result.outcome.artifacts.some(
          (artifact) => artifact.name === ".oma/pr-review-findings.json",
        ),
      ).toBe(true);
      expect(result.plan.inline).toHaveLength(1);
    } finally {
      await rm(cwd, {
        recursive: true,
        force: true,
      });
    }
  });
});
