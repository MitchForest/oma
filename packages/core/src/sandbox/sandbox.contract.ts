import { expect, test } from "bun:test";
import type { SandboxPolicy, SandboxProvider } from "./sandbox";

export interface SandboxContractOptions {
  supportsCwd?: boolean;
  /** Shell used for every contract exec. Must exist in the sandbox image. */
  allowedCommand?: string;
  blockedCommand?: string;
}

/**
 * Environment variables that sandbox runtimes (shells, docker images) commonly
 * define on their own. The env-isolation test must not pick one of these as
 * its "parent-only" sentinel.
 */
const RUNTIME_DEFAULT_ENV = new Set([
  "PATH",
  "HOME",
  "HOSTNAME",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CHARSET",
  "_"
]);

function parentOnlyEnvVar(): string | undefined {
  return Object.keys(process.env).find(
    (key) =>
      !RUNTIME_DEFAULT_ENV.has(key) &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      (process.env[key] ?? "") !== ""
  );
}

export function runSandboxProviderContractTests(
  name: string,
  makeProvider: () => SandboxProvider,
  makePolicy: () => SandboxPolicy,
  options: SandboxContractOptions = {}
): void {
  const shell = options.allowedCommand ?? "sh";
  const blockedCommand = options.blockedCommand ?? "echo";
  const sh = (script: string): { command: string; args: string[] } => ({
    command: shell,
    args: ["-c", script]
  });

  test(`${name}: provisions, executes, and destroys`, async () => {
    const sandbox = await makeProvider().provision(makePolicy());

    try {
      expect(typeof sandbox.id).toBe("string");
      expect(sandbox.policy.kind).toBe(makePolicy().kind);

      const result = await sandbox.exec({
        ...sh("echo sandbox-ok")
      });

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "sandbox-ok\n",
        timedOut: false,
        truncated: false
      });
    } finally {
      await sandbox.destroy();
      await sandbox.destroy();
    }
  });

  test(`${name}: returns non-zero exit codes instead of throwing`, async () => {
    const sandbox = await makeProvider().provision(makePolicy());

    try {
      const result = await sandbox.exec({
        ...sh("echo boom >&2; exit 7")
      });

      expect(result.exitCode).toBe(7);
      expect(result.stderr).toBe("boom\n");
      expect(result.timedOut).toBe(false);
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: isolates env by default and passes explicit env`, async () => {
    const sentinel = parentOnlyEnvVar();
    const sandbox = await makeProvider().provision(makePolicy());

    try {
      if (sentinel) {
        const isolated = await sandbox.exec({
          ...sh(`echo "\${${sentinel}:-missing}"`)
        });
        expect(isolated.stdout).toBe("missing\n");
      }

      const explicit = await sandbox.exec({
        ...sh('echo "${OMA_SANDBOX_ALLOWED_VALUE:-missing}"'),
        env: { OMA_SANDBOX_ALLOWED_VALUE: "visible" }
      });
      expect(explicit.stdout).toBe("visible\n");
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: enforces command allowlist`, async () => {
    const sandbox = await makeProvider().provision({
      ...makePolicy(),
      allowedCommands: [shell]
    });

    try {
      await expect(
        sandbox.exec({ command: blockedCommand, args: ["blocked"] })
      ).rejects.toThrow("not allowed");
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: reports timeout`, async () => {
    const sandbox = await makeProvider().provision(makePolicy());

    try {
      const result = await sandbox.exec({
        ...sh("sleep 10"),
        timeoutMs: 500
      });

      expect(result.timedOut).toBe(true);
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: truncates output past the limit`, async () => {
    const sandbox = await makeProvider().provision(makePolicy());

    try {
      const result = await sandbox.exec({
        ...sh("echo abcdefghijklmnop"),
        outputLimitBytes: 12
      });

      expect(result).toMatchObject({
        stdout: "...[truncated]",
        truncated: true
      });
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: policy timeoutMs caps request timeoutMs`, async () => {
    const sandbox = await makeProvider().provision({
      ...makePolicy(),
      timeoutMs: 500
    });

    try {
      const result = await sandbox.exec({
        ...sh("sleep 10"),
        timeoutMs: 60_000
      });

      expect(result.timedOut).toBe(true);
    } finally {
      await sandbox.destroy();
    }
  });

  test(`${name}: policy outputLimitBytes caps request outputLimitBytes`, async () => {
    const sandbox = await makeProvider().provision({
      ...makePolicy(),
      outputLimitBytes: 12
    });

    try {
      const result = await sandbox.exec({
        ...sh("echo abcdefghijklmnop"),
        outputLimitBytes: 1_000_000
      });

      expect(result).toMatchObject({
        stdout: "...[truncated]",
        truncated: true
      });
    } finally {
      await sandbox.destroy();
    }
  });
}
