# @oma/adapter-sandbox-worktree

Disposable git worktree sandbox for local coding-agent runs.

It creates a temporary branch/worktree, delegates command execution to the local sandbox, and removes the worktree on `destroy()` when cleanup policy permits it. `cleanup: "on-success"` is conservative: it preserves the worktree unless destroy is called with an explicit successful outcome.

```json
{
  "kind": "worktree",
  "repo": ".",
  "baseRef": "HEAD",
  "root": ".oma/worktrees",
  "cleanup": "always",
  "allowedCommands": ["bun", "git", "rg"]
}
```

Environment inheritance is intentionally narrow: sandboxed commands receive `PATH` plus explicit policy/request env only.

Session ids are sanitized into git-refname/path safe slugs with a uniqueness suffix (keyed ids like `review:owner/repo#42` are supported), and the resolved worktree path is verified to stay inside the worktree root.

Policy limits are caps, not defaults: `timeoutMs`/`outputLimitBytes` in the policy bound what individual exec requests may ask for. `network: "disabled"` is not supported by this adapter and is rejected at provision time (use the docker sandbox to disable network access).
