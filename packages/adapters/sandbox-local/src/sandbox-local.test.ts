import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSandboxProviderContractTests } from "@oma/core";
import { LocalSandboxProvider, resolveWithinRoot } from "./index";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "oma-sandbox-local-"));
}

runSandboxProviderContractTests(
  "LocalSandboxProvider",
  () => new LocalSandboxProvider(),
  () => ({
    kind: "local",
    cwd: cwd(),
    allowedCommands: ["sh"]
  })
);

test("LocalSandbox rejects cwd escapes", async () => {
  const sandbox = await new LocalSandboxProvider().provision({
    kind: "local",
    cwd: cwd(),
    allowedCommands: ["sh"]
  });

  try {
    await expect(
      sandbox.exec({ command: "sh", args: ["-c", "pwd"], cwd: ".." })
    ).rejects.toThrow("escapes root");
    await expect(
      sandbox.exec({ command: "sh", args: ["-c", "pwd"], cwd: "..foo/../.." })
    ).rejects.toThrow("escapes root");
  } finally {
    await sandbox.destroy();
  }
});

test("LocalSandbox allows sibling-prefixed paths inside the root (..foo)", async () => {
  const root = cwd();
  const sandbox = await new LocalSandboxProvider().provision({
    kind: "local",
    cwd: root,
    allowedCommands: ["sh"]
  });

  try {
    await Bun.write(join(root, "..foo/.keep"), "");
    const result = await sandbox.exec({ command: "sh", args: ["-c", "pwd"], cwd: "..foo" });
    expect(result.exitCode).toBe(0);
  } finally {
    await sandbox.destroy();
  }
});

test("LocalSandbox rejects symlinked cwd escapes", async () => {
  const root = cwd();
  const outside = mkdtempSync(join(tmpdir(), "oma-sandbox-outside-"));

  symlinkSync(outside, join(root, "escape"));

  const sandbox = await new LocalSandboxProvider().provision({
    kind: "local",
    cwd: root,
    allowedCommands: ["sh"]
  });

  try {
    await expect(
      sandbox.exec({ command: "sh", args: ["-c", "pwd"], cwd: "escape" })
    ).rejects.toThrow("escapes root");
  } finally {
    await sandbox.destroy();
  }
});

test("resolveWithinRoot rejects symlinks pointing outside the root", async () => {
  const root = cwd();
  const outside = mkdtempSync(join(tmpdir(), "oma-sandbox-outside-"));

  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "evil"));
  symlinkSync(join(outside, "secret.txt"), join(root, "evil-file"));

  // Existing file behind a symlinked directory.
  await expect(resolveWithinRoot(root, "evil/secret.txt")).rejects.toThrow("escapes root");
  // Direct symlink to an outside file.
  await expect(resolveWithinRoot(root, "evil-file")).rejects.toThrow("escapes root");
  // Not-yet-existing file under a symlinked directory (write path).
  await expect(resolveWithinRoot(root, "evil/new-file.txt")).rejects.toThrow("escapes root");
  // Legitimate paths still resolve.
  await Bun.write(join(root, "ok.txt"), "ok");
  expect(await resolveWithinRoot(root, "ok.txt")).toBe(join(root, "ok.txt"));
  expect(await resolveWithinRoot(root, "new-dir/new-file.txt")).toBe(
    join(root, "new-dir/new-file.txt")
  );
});

test("LocalSandbox escalates to SIGKILL when SIGTERM is ignored", async () => {
  const sandbox = await new LocalSandboxProvider().provision({
    kind: "local",
    cwd: cwd(),
    allowedCommands: ["sh"]
  });

  try {
    const startedAt = performance.now();
    const result = await sandbox.exec({
      command: "sh",
      args: ["-c", 'trap "" TERM; sleep 30'],
      timeoutMs: 200
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.timedOut).toBe(true);
    // 200ms timeout + 2s SIGKILL grace, with headroom; far below the 30s sleep.
    expect(elapsedMs).toBeLessThan(10_000);
  } finally {
    await sandbox.destroy();
  }
}, 15_000);

test("LocalSandboxProvider rejects unsupported network policy at provision", async () => {
  await expect(
    new LocalSandboxProvider().provision({
      kind: "local",
      cwd: cwd(),
      network: "disabled"
    })
  ).rejects.toThrow('local sandbox adapter does not support network: "disabled"');
});
