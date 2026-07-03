import {
  effectiveLimit,
  isCleanupDeferred,
  readStreamCapped,
  shouldCleanup,
  type Sandbox,
  type SandboxDestroyOptions,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProvisionContext
} from "@oma/core";

export interface DockerSandboxPolicy extends SandboxPolicy {
  kind: "docker";
  image?: string;
  workdir?: string;
  mount?: string;
  /**
   * How the host mount is attached. Defaults to "rw" for compatibility with
   * existing profiles, but note the risk: the container runs as root and a
   * rw mount lets contained code rewrite the mounted host directory. Prefer
   * "ro" for untrusted workloads.
   */
  mountMode?: "ro" | "rw";
  /** Container memory limit (docker `--memory` syntax). Default "2g". */
  memory?: string;
  /** Container pid limit (docker `--pids-limit`). Default 512. */
  pidsLimit?: number;
}

const SIGKILL_GRACE_MS = 2_000;
const CONTROL_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY = "2g";
const DEFAULT_PIDS_LIMIT = 512;

export class DockerSandboxProvider implements SandboxProvider {
  async provision(
    policy: SandboxPolicy = { kind: "docker" },
    context: SandboxProvisionContext = {}
  ): Promise<Sandbox> {
    const dockerPolicy = normalizePolicy(policy);

    if (!dockerPolicy.image) {
      throw new Error("Docker sandbox policy requires image");
    }

    const id = context.sessionId ?? crypto.randomUUID();
    const slug = id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
    // Uniqueness suffix: session ids repeat across wakes and container names
    // must be unique. The `oma` label marks containers for orphan GC.
    const name = `oma-${slug}-${crypto.randomUUID().slice(0, 8)}`;
    const workdir = dockerPolicy.workdir ?? "/workspace";
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "oma=sandbox",
      "--memory",
      dockerPolicy.memory ?? DEFAULT_MEMORY,
      "--pids-limit",
      String(dockerPolicy.pidsLimit ?? DEFAULT_PIDS_LIMIT),
      "-w",
      workdir
    ];

    if (dockerPolicy.network === "disabled") {
      args.push("--network", "none");
    }

    if (dockerPolicy.mount) {
      const suffix = dockerPolicy.mountMode === "ro" ? ":ro" : "";
      args.push("-v", `${dockerPolicy.mount}:${workdir}${suffix}`);
    }

    args.push(dockerPolicy.image, "tail", "-f", "/dev/null");
    await dockerControl(args);

    return new DockerSandbox(`docker:${name}`, dockerPolicy, name, workdir);
  }
}

class DockerSandbox implements Sandbox {
  private destroyed = false;
  private unusable = false;

  constructor(
    readonly id: string,
    readonly policy: DockerSandboxPolicy,
    private readonly name: string,
    private readonly workdir: string
  ) {}

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.destroyed) {
      throw new Error(`Sandbox is destroyed: ${this.id}`);
    }

    if (this.unusable) {
      throw new Error(
        `Sandbox is unusable after an exec timeout (container was killed): ${this.id}`
      );
    }

    assertAllowed(request.command, this.policy.allowedCommands);
    // Policy is a cap, not a default: requests may tighten limits, never loosen them.
    const timeoutMs = effectiveLimit(request.timeoutMs, this.policy.timeoutMs, 30_000);
    const outputLimitBytes = effectiveLimit(
      request.outputLimitBytes,
      this.policy.outputLimitBytes,
      64_000
    );
    const args = ["exec", "-w", request.cwd ?? this.workdir];

    for (const [key, value] of Object.entries({
      ...this.policy.env,
      ...request.env
    })) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(this.name, request.command, ...(request.args ?? []));

    const proc = Bun.spawn(["docker", ...args], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // Captured (not thrown) inside the timer callback to avoid an unhandled
    // rejection while the exec promises are still settling.
    let containerKill: Promise<Error | undefined> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // Killing the docker CLI client alone leaves the command running inside
      // the container; kill the container itself. This makes the sandbox
      // unusable — callers must provision a fresh one.
      containerKill = dockerControl(["kill", this.name]).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
      );
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamCapped(proc.stdout, outputLimitBytes),
        readStreamCapped(proc.stderr, outputLimitBytes),
        proc.exited
      ]);

      if (timedOut) {
        this.unusable = true;
        const killError = await containerKill;

        if (killError) {
          throw killError;
        }
      }

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
    }
  }

  async destroy(options?: SandboxDestroyOptions): Promise<void> {
    if (this.destroyed) {
      return;
    }

    if (!shouldCleanup(this.policy, options)) {
      if (isCleanupDeferred(this.policy, options)) {
        // No outcome yet under cleanup: "on-success" — stay destroyable so a
        // later destroy({ outcome }) can still decide.
        return;
      }

      this.destroyed = true;
      return;
    }

    try {
      await dockerControl(["rm", "-f", this.name]);
    } catch (error) {
      console.error(`Failed to remove container for sandbox ${this.id}:`, error);
    }

    this.destroyed = true;
  }
}

function normalizePolicy(policy: SandboxPolicy): DockerSandboxPolicy {
  return {
    ...policy,
    kind: "docker",
    image: typeof policy.image === "string" ? policy.image : undefined,
    workdir: typeof policy.workdir === "string" ? policy.workdir : undefined,
    mount: typeof policy.mount === "string" ? policy.mount : undefined,
    mountMode: policy.mountMode === "ro" ? "ro" : "rw",
    memory: typeof policy.memory === "string" ? policy.memory : undefined,
    pidsLimit: typeof policy.pidsLimit === "number" ? policy.pidsLimit : undefined
  };
}

/**
 * Control-plane docker invocation (`run`, `rm`, `kill`): throws on non-zero
 * exit. The exec data path never goes through here — exec results are
 * returned to the caller, exit code and all, per the sandbox contract.
 */
async function dockerControl(args: string[], timeoutMs = CONTROL_TIMEOUT_MS): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    if (timedOut) {
      throw new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`);
    }

    if (exitCode !== 0) {
      throw new Error(`docker ${args.join(" ")} failed: ${stderr || stdout}`);
    }

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function assertAllowed(command: string, allowedCommands: string[] | undefined): void {
  if (allowedCommands && !allowedCommands.includes(command)) {
    throw new Error(`Command is not allowed by sandbox policy: ${command}`);
  }
}
