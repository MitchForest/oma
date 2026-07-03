import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  effectiveLimit,
  readStreamCapped,
  type Sandbox,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProvisionContext
} from "@oma/core";

const SIGKILL_GRACE_MS = 2_000;
const STREAM_GRACE_MS = 250;

export class LocalSandboxProvider implements SandboxProvider {
  async provision(
    policy: SandboxPolicy = { kind: "local" },
    context: SandboxProvisionContext = {}
  ): Promise<Sandbox> {
    return new LocalSandbox(policy, context);
  }
}

export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly policy: SandboxPolicy;
  private readonly rootCwd: string;
  private destroyed = false;

  constructor(policy: SandboxPolicy = { kind: "local" }, context: SandboxProvisionContext = {}) {
    assertSupportedPolicy(policy, policy.kind || "local");
    this.id = `local:${context.sessionId ?? crypto.randomUUID()}`;
    this.policy = {
      ...policy,
      kind: policy.kind || "local"
    };
    this.rootCwd = resolve(String(policy.cwd ?? process.cwd()));
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.destroyed) {
      throw new Error(`Sandbox is destroyed: ${this.id}`);
    }

    assertAllowed(request.command, this.policy.allowedCommands);
    const cwd = await this.resolveCwd(request.cwd);
    // Policy is a cap, not a default: requests may tighten limits, never loosen them.
    const timeoutMs = effectiveLimit(request.timeoutMs, this.policy.timeoutMs, 30_000);
    const outputLimitBytes = effectiveLimit(
      request.outputLimitBytes,
      this.policy.outputLimitBytes,
      64_000
    );
    const proc = Bun.spawn([request.command, ...(request.args ?? [])], {
      cwd,
      env: sandboxEnv(this.policy.env, request.env),
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Bun.spawn does not expose `detached`, so the child shares our process
      // group and a group-wide kill (process.kill(-pid)) would signal the
      // harness itself. We escalate to SIGKILL on the child only; grandchild
      // processes that the child spawned may survive the kill.
      killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    // Grandchild processes inherit the stdout/stderr pipes and can hold them
    // open after the spawned child itself exited (we cannot kill them — see
    // the process-group note above). Read the streams concurrently, but once
    // the child exits give residual output a short grace period and then stop
    // reading instead of waiting for the pipes to close.
    const streamCutoff = new AbortController();
    const stdoutPromise = readStreamCapped(proc.stdout, outputLimitBytes, streamCutoff.signal);
    const stderrPromise = readStreamCapped(proc.stderr, outputLimitBytes, streamCutoff.signal);
    let cutoffTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const exitCode = await proc.exited;
      cutoffTimer = setTimeout(() => streamCutoff.abort(), STREAM_GRACE_MS);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

      return {
        exitCode,
        stdout: stdout.value,
        stderr: stderr.value,
        timedOut,
        truncated: stdout.truncated || stderr.truncated
      };
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(cutoffTimer);
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  private async resolveCwd(cwd: string | undefined): Promise<string> {
    if (!cwd) {
      return this.rootCwd;
    }

    return resolveWithinRoot(this.rootCwd, cwd);
  }
}

/**
 * Resolve `path` against `root` and verify the result stays inside `root`,
 * both lexically and after resolving symlinks (the deepest existing ancestor
 * is realpath'd, so a committed `evil -> /` symlink cannot escape).
 *
 * Returns the lexically resolved path.
 */
export async function resolveWithinRoot(root: string, path: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, path);
  assertContained(resolvedRoot, resolved, path);

  const realRoot = await realpath(resolvedRoot);
  const realResolved = await realpathDeepestExisting(resolved);
  assertContained(realRoot, realResolved, path);

  return resolved;
}

function assertContained(root: string, target: string, original: string): void {
  const rel = relative(root, target);

  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes root: ${original}`);
  }
}

async function realpathDeepestExisting(path: string): Promise<string> {
  let current = path;
  const missing: string[] = [];

  while (true) {
    try {
      const real = await realpath(current);
      return missing.reduce((acc, segment) => resolve(acc, segment), real);
    } catch {
      const parent = dirname(current);

      if (parent === current) {
        // Nothing on the path exists (not even the filesystem root entry);
        // fall back to the lexical resolution.
        return path;
      }

      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function sandboxEnv(
  policyEnv: Record<string, string> | undefined,
  requestEnv: Record<string, string> | undefined
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    ...policyEnv,
    ...requestEnv
  };
}

export function assertSupportedPolicy(policy: SandboxPolicy, adapter: string): void {
  if (policy.network === "disabled") {
    throw new Error(
      `The ${adapter} sandbox adapter does not support network: "disabled"; ` +
        `use the docker sandbox adapter to disable network access`
    );
  }
}

function assertAllowed(command: string, allowedCommands: string[] | undefined): void {
  if (allowedCommands && !allowedCommands.includes(command)) {
    throw new Error(`Command is not allowed by sandbox policy: ${command}`);
  }
}
