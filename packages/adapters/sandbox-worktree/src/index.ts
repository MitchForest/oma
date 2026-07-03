import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalSandbox } from "@oma/adapter-sandbox-local";
import {
  isCleanupDeferred,
  shouldCleanup,
  type Sandbox,
  type SandboxDestroyOptions,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProvisionContext
} from "@oma/core";

export interface WorktreeSandboxPolicy extends SandboxPolicy {
  kind: "worktree";
  repo?: string;
  baseRef?: string;
  root?: string;
}

const MAX_SLUG_LENGTH = 48;

export class WorktreeSandboxProvider implements SandboxProvider {
  async provision(
    policy: SandboxPolicy = { kind: "worktree" },
    context: SandboxProvisionContext = {}
  ): Promise<Sandbox> {
    const worktreePolicy = normalizePolicy(policy);

    if (worktreePolicy.network === "disabled") {
      throw new Error(
        'The worktree sandbox adapter does not support network: "disabled"; ' +
          "use the docker sandbox adapter to disable network access"
      );
    }

    const repo = resolve(worktreePolicy.repo ?? process.cwd());
    const root = resolve(worktreePolicy.root ?? join(repo, ".oma/worktrees"));
    const id = context.sessionId ?? crypto.randomUUID();
    // Session ids are externally derived (e.g. `review:owner/repo#42`) and are
    // neither valid git refnames nor trustworthy path segments. Sanitize and
    // add a uniqueness suffix so distinct ids cannot collide after cleanup.
    const slug = `${sanitizeSessionId(id)}-${crypto.randomUUID().slice(0, 8)}`;
    const branch = `oma/${slug}`;
    const path = resolve(root, slug);
    const relativePath = relative(root, path);

    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Worktree path escapes worktree root for session id: ${id}`);
    }

    await mkdir(root, { recursive: true });
    await git(["-C", repo, "worktree", "add", "-b", branch, path, worktreePolicy.baseRef ?? "HEAD"]);

    const local = new LocalSandbox(
      {
        ...worktreePolicy,
        kind: "worktree",
        cwd: path
      },
      context
    );

    return new WorktreeSandbox(`worktree:${slug}`, local.policy, local, repo, path, branch);
  }
}

export function sanitizeSessionId(id: string): string {
  const sanitized = id
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    // git refname components must not contain ".." or start with "." or "-".
    .replace(/\.{2,}/g, "-")
    .replace(/^[.-]+/, "");
  const sliced = sanitized.slice(0, MAX_SLUG_LENGTH).replace(/[.-]+$/, "");

  return sliced || "session";
}

class WorktreeSandbox implements Sandbox {
  private destroyed = false;

  constructor(
    readonly id: string,
    readonly policy: SandboxPolicy,
    private readonly local: Sandbox,
    private readonly repo: string,
    private readonly path: string,
    private readonly branch: string
  ) {}

  exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.destroyed) {
      throw new Error(`Sandbox is destroyed: ${this.id}`);
    }

    return this.local.exec(request);
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
      await this.local.destroy();
      return;
    }

    await this.local.destroy();

    try {
      await git(["-C", this.repo, "worktree", "remove", "--force", this.path]);
    } catch (error) {
      console.error(`Failed to remove worktree for sandbox ${this.id}:`, error);
    }

    try {
      await git(["-C", this.repo, "branch", "-D", this.branch]);
    } catch (error) {
      console.error(`Failed to delete branch for sandbox ${this.id}:`, error);
    }

    this.destroyed = true;
  }
}

function normalizePolicy(policy: SandboxPolicy): WorktreeSandboxPolicy {
  return {
    ...policy,
    kind: "worktree",
    repo: typeof policy.repo === "string" ? policy.repo : undefined,
    baseRef: typeof policy.baseRef === "string" ? policy.baseRef : undefined,
    root: typeof policy.root === "string" ? policy.root : undefined
  };
}

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
}
