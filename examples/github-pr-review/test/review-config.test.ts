import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepositoryInstructions, loadReviewConfig } from "../src/review-config";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "oma-review-config-"));
}

describe("review config", () => {
  test("uses defaults when no config file exists", async () => {
    const root = await tempDir();
    try {
      const config = await loadReviewConfig({ root });
      expect(config.maxInlineComments).toBe(10);
      expect(config.inlineRisk).toEqual(["high"]);
      expect(config.instructionFiles).toContain("AGENTS.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads example-local review policy", async () => {
    const root = await tempDir();
    try {
      await writeFile(
        join(root, "review.config.json"),
        JSON.stringify({
          maxInlineComments: 2,
          inlineRisk: ["high", "medium"],
          inlineConfidence: ["high"],
          excludePaths: ["generated/**"],
          instructionFiles: ["AGENTS.md"],
        }),
      );

      const config = await loadReviewConfig({ root });
      expect(config.maxInlineComments).toBe(2);
      expect(config.inlineRisk).toEqual(["high", "medium"]);
      expect(config.excludePaths).toEqual(["generated/**"]);
      expect(config.instructionFiles).toEqual(["AGENTS.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("loads repository instructions and ignores missing files", async () => {
    const workspace = await tempDir();
    try {
      await mkdir(join(workspace, ".cursor"));
      await writeFile(join(workspace, "AGENTS.md"), "Prefer explicit code.");
      await writeFile(join(workspace, ".cursor", "BUGBOT.md"), "Focus on logic errors.");

      const instructions = await loadRepositoryInstructions({
        workspace,
        files: ["AGENTS.md", "CLAUDE.md", ".cursor/BUGBOT.md"],
      });

      expect(instructions).toEqual([
        {
          path: "AGENTS.md",
          content: "Prefer explicit code.",
        },
        {
          path: ".cursor/BUGBOT.md",
          content: "Focus on logic errors.",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects instruction paths outside the repository", async () => {
    const workspace = await tempDir();
    try {
      await expect(
        loadRepositoryInstructions({
          workspace,
          files: ["../outside.md"],
        }),
      ).rejects.toThrow("repository-relative");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
