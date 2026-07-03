import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSandboxProviderContractTests } from "@oma/core";
import { WorktreeSandboxProvider, sanitizeSessionId } from "./index";

runSandboxProviderContractTests(
  "WorktreeSandboxProvider",
  () => new WorktreeSandboxProvider(),
  () => ({
    kind: "worktree",
    repo: setupRepo(),
    allowedCommands: ["sh"],
    cleanup: "always"
  })
);

test("worktree sandbox isolates file mutations from the source repo", async () => {
  const repo = setupRepo();
  const sandbox = await new WorktreeSandboxProvider().provision({
    kind: "worktree",
    repo,
    allowedCommands: ["sh"],
    cleanup: "always"
  });

  try {
    const result = await sandbox.exec({
      command: "sh",
      args: ["-c", "printf changed > file.txt"]
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(repo, "file.txt")).text()).toBe("original\n");
  } finally {
    await sandbox.destroy();
  }
});

test("worktree sandbox accepts keyed session ids and keeps the path inside the root", async () => {
  const repo = setupRepo();
  const root = join(repo, ".oma/worktrees");
  const provider = new WorktreeSandboxProvider();
  const sandbox = await provider.provision(
    { kind: "worktree", repo, allowedCommands: ["sh"], cleanup: "always" },
    { sessionId: "review:owner/repo#42" }
  );

  try {
    const result = await sandbox.exec({ command: "sh", args: ["-c", "pwd"] });

    expect(result.exitCode).toBe(0);
    const path = result.stdout.trim();
    expect(await Bun.file(join(path, "file.txt")).text()).toBe("original\n");
    // Resolved path must live inside the worktree root, not at a
    // session-id-controlled location.
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(path).startsWith(realpathSync(root))).toBe(true);
  } finally {
    await sandbox.destroy();
  }

  // Cleanup removed the worktree and a second provision with the same keyed
  // id does not collide.
  const again = await provider.provision(
    { kind: "worktree", repo, allowedCommands: ["sh"], cleanup: "always" },
    { sessionId: "review:owner/repo#42" }
  );
  await again.destroy();
});

test("worktree sandbox destroy removes the worktree and branch", async () => {
  const repo = setupRepo();
  const sandbox = await new WorktreeSandboxProvider().provision({
    kind: "worktree",
    repo,
    allowedCommands: ["sh"],
    cleanup: "always"
  });

  const pwd = await sandbox.exec({ command: "sh", args: ["-c", "pwd"] });
  const path = pwd.stdout.trim();

  await sandbox.destroy();

  expect(existsSync(path)).toBe(false);
  const branches = Bun.spawnSync(["git", "-C", repo, "branch", "--list", "oma/*"], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  expect(new TextDecoder().decode(branches.stdout).trim()).toBe("");
});

test("sanitizeSessionId produces git-refname/path safe slugs", () => {
  expect(sanitizeSessionId("review:owner/repo#42")).toBe("review-owner-repo-42");
  expect(sanitizeSessionId("../../etc/passwd")).toBe("etc-passwd");
  expect(sanitizeSessionId(".hidden..name")).toBe("hidden-name");
  expect(sanitizeSessionId("###")).toBe("session");
  expect(sanitizeSessionId("x".repeat(200)).length).toBeLessThanOrEqual(48);
});

test("WorktreeSandboxProvider rejects unsupported network policy at provision", async () => {
  await expect(
    new WorktreeSandboxProvider().provision({
      kind: "worktree",
      repo: setupRepo(),
      network: "disabled"
    })
  ).rejects.toThrow('worktree sandbox adapter does not support network: "disabled"');
});

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "oma-worktree-repo-"));

  run("git", ["init", "-q"], repo);
  run("git", ["config", "user.email", "test@example.com"], repo);
  run("git", ["config", "user.name", "Test User"], repo);
  writeFileSync(join(repo, "file.txt"), "original\n");
  run("git", ["add", "file.txt"], repo);
  run("git", ["commit", "-q", "-m", "initial"], repo);

  return repo;
}

function run(command: string, args: string[], cwd: string): void {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}
