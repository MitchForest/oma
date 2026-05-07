# Claude Code Harness Smoke Test

This smoke test verifies that `@oma/harness-claude-code` can drive a real Claude Code process in print mode with streaming JSON output from a trusted local workspace.

## Requirements

- Bun dependencies installed with `bun install`.
- Claude Code installed and available on `PATH`.
- Claude Code authenticated, or `ANTHROPIC_API_KEY` available for `--bare` mode.
- A workspace where it is acceptable for Claude Code to write files and run commands.

Claude Code documents `claude -p` / `--print` for non-interactive execution, `--output-format stream-json` for line-delimited JSON streaming, `--include-partial-messages` for partial message chunks, `--include-hook-events` for hook lifecycle events, `--no-session-persistence` for ephemeral print-mode sessions, `--bare` for deterministic minimal startup, and `--permission-mode` / tool allowlists for automation safety.

## Manual Smoke

From the OMA repository root:

```sh
claude --version
bun test packages/harnesses/claude-code/test/claude-code.test.ts
```

Then run a real OMA harness invocation against a disposable workspace:

```sh
mkdir -p /tmp/oma-claude-smoke
mkdir -p .oma
cat > .oma/claude-smoke.ts <<'EOF'
import { localEnvironment } from "@oma/environment-local";
import { claudeCodeHarness } from "@oma/harness-claude-code";
import { objective, outcomes, run, sessions, validators } from "@oma/runtime";

const session = sessions.ephemeral();
const environment = localEnvironment({ workspace: "/tmp/oma-claude-smoke" });

const outcome = await run({
  objective: objective({
    goal: "Write a concise final report that says OMA Claude Code smoke passed.",
    constraints: ["Do not make code changes"],
    success: ["The final Claude Code report exists"],
  }),
  process: {
    session,
    harness: claudeCodeHarness({
      bare: true,
      includePatch: false,
      timeoutMs: 120_000,
      tools: ["Read", "Write"],
    }),
  },
  environment,
  validation: [validators.artifactExists(".oma/claude-report.md")],
});

await outcomes.write(outcome, {
  environment,
  session,
  jsonPath: ".oma/outcome.json",
  markdownPath: ".oma/outcome.md",
});

console.log(outcome.status);
EOF

bun run .oma/claude-smoke.ts
cat /tmp/oma-claude-smoke/.oma/outcome.md
```

Expected result:

- The command prints `succeeded`.
- `.oma/claude-objective.md` contains the rendered OMA objective.
- `.oma/claude-report.md` contains the Claude Code final report.
- `.oma/claude-events.jsonl` is collected as a log artifact.
- `.oma/outcome.md` includes normalized OMA observations from Claude Code events.

Do not add this smoke path to default CI. It depends on local credentials, network availability, and a tool that can mutate the workspace.
