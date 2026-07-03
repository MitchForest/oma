# @oma/adapter-tools-local

First-party local tool bundle for the OMA CLI runtime.

Tools:

- `read_file`
- `write_file`
- `replace_in_file`
- `list_files`
- `search`
- `bash`
- `git_status`
- `git_diff`
- `run_tests`

The tools enforce configured cwd boundaries (lexically and through symlinks — a symlink pointing outside the cwd is rejected), timeouts, output caps, optional env, and an optional allowed-command policy for shell execution. Command-oriented tools execute through `Sandbox.exec`; if no sandbox is supplied, the adapter lazily provisions a local sandbox. `run_tests` executes the configured command directly as argv, so `allowedCommands: ["bun"]` permits `testCommand: "bun test"`.

`allowedCommands` governs model-chosen executables only: `bash` commands and `run_tests` commands. Harness-issued helpers (`rg` backing `search`/`list_files`, `git` backing `git_status`/`git_diff`) are exempt. To restrict the sandbox itself, set `sandboxPolicy.allowedCommands` — which then must include `rg` and `git` for those tools to work.

`replace_in_file` requires the `old` text to match exactly once and inserts the replacement literally (`$&`-style patterns are not interpreted).

```ts
import { createLocalTools } from "@oma/adapter-tools-local";

const tools = createLocalTools({
  cwd: process.cwd(),
  testCommand: "bun test",
  timeoutMs: 30_000,
  outputLimitBytes: 64_000,
  allowedCommands: ["bun", "git", "printf"]
});
```

To run commands through a caller-provided sandbox:

```ts
const tools = createLocalTools({
  cwd: process.cwd(),
  sandbox,
  testCommand: "bun test"
});
```
