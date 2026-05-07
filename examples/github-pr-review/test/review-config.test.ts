import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
      expect(config.maxInstructionBytes).toBe(24000);
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

  test("rejects backslash instruction paths", async () => {
    const workspace = await tempDir();
    try {
      await expect(
        loadRepositoryInstructions({
          workspace,
          files: [".git\\config"],
        }),
      ).rejects.toThrow("forward slashes");
      await expect(
        loadRepositoryInstructions({
          workspace,
          files: ["docs\\AGENTS.md"],
        }),
      ).rejects.toThrow("forward slashes");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects nested sensitive instruction paths", async () => {
    const workspace = await tempDir();
    try {
      for (const path of [
        "docs/.env",
        "docs/.env.local",
        "docs/.git/config",
        "docs/node_modules/pkg/README.md",
        "docs/.oma/pr-review.md",
      ]) {
        await expect(
          loadRepositoryInstructions({
            workspace,
            files: [path],
          }),
        ).rejects.toThrow("sensitive");
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("allows the dedicated OMA review instruction file", async () => {
    const workspace = await tempDir();
    try {
      await mkdir(join(workspace, ".oma"));
      await writeFile(join(workspace, ".oma", "pr-review.md"), "Use strict review criteria.");

      const instructions = await loadRepositoryInstructions({
        workspace,
        files: [".oma/pr-review.md"],
      });

      expect(instructions).toEqual([
        {
          path: ".oma/pr-review.md",
          content: "Use strict review criteria.",
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("rejects sensitive and symlinked instruction paths", async () => {
    const workspace = await tempDir();
    try {
      await writeFile(join(workspace, "real.md"), "Use explicit code.");
      await symlink(join(workspace, "real.md"), join(workspace, "linked.md"));

      await expect(
        loadRepositoryInstructions({
          workspace,
          files: [".env"],
        }),
      ).rejects.toThrow("sensitive");
      await expect(
        loadRepositoryInstructions({
          workspace,
          files: ["linked.md"],
        }),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("throws when an explicit review config is missing", async () => {
    const root = await tempDir();
    try {
      await expect(
        loadReviewConfig({
          root,
          configPath: "missing.json",
        }),
      ).rejects.toThrow("explicit review config was not found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps loaded repository instruction content", async () => {
    const workspace = await tempDir();
    try {
      await writeFile(join(workspace, "AGENTS.md"), "0123456789");

      const instructions = await loadRepositoryInstructions({
        workspace,
        files: ["AGENTS.md"],
        maxBytes: 4,
      });

      expect(instructions[0]?.content).toBe("0123\n... truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
