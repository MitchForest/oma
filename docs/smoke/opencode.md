# OpenCode Harness Smoke Test

This smoke test verifies that `@oma/harness-opencode` can drive a real OpenCode process in non-interactive JSON output mode from a trusted local workspace.

## Requirements

- Bun dependencies installed with `bun install`.
- OpenCode installed and available on `PATH`.
- OpenCode authenticated with `opencode auth login` or provider environment variables.
- A workspace where it is acceptable for OpenCode to write files and run commands.

OpenCode documents `opencode run` for non-interactive automation, `--format json` for raw JSON events, `opencode serve` for the headless HTTP server, `@opencode-ai/sdk` for the generated TypeScript client, and `opencode acp` for Agent Client Protocol over stdin/stdout nd-JSON.

## Manual Smoke

From the OMA repository root:

```sh
opencode --version
bun test packages/harnesses/opencode/test/opencode.test.ts
```

Then run a real OMA harness invocation against a disposable workspace:

```sh
mkdir -p /tmp/oma-opencode-smoke
mkdir -p .oma
cat > .oma/opencode-smoke.ts <<'EOF'
import { localEnvironment } from "@oma/environment-local";
import { opencodeHarness } from "@oma/harness-opencode";
import { objective, outcomes, run, sessions, validators } from "@oma/runtime";

const session = sessions.ephemeral();
const environment = localEnvironment({ workspace: "/tmp/oma-opencode-smoke" });

const outcome = await run({
  objective: objective({
    goal: "Write a concise final report that says OMA OpenCode smoke passed.",
    constraints: ["Do not make code changes"],
    success: ["The final OpenCode report exists"],
  }),
  process: {
    session,
    harness: opencodeHarness({
      includePatch: false,
      pure: true,
      timeoutMs: 120_000,
    }),
  },
  environment,
  validation: [validators.artifactExists(".oma/opencode-report.md")],
});

await outcomes.write(outcome, {
  environment,
  session,
  jsonPath: ".oma/outcome.json",
  markdownPath: ".oma/outcome.md",
});

console.log(outcome.status);
EOF

bun run .oma/opencode-smoke.ts
cat /tmp/oma-opencode-smoke/.oma/outcome.md
```

Expected result:

- The command prints `succeeded`.
- `.oma/opencode-objective.md` contains the rendered OMA objective.
- `.oma/opencode-report.md` contains the OpenCode final report.
- `.oma/opencode-events.jsonl` is collected as a log artifact.
- `.oma/outcome.md` includes normalized OMA observations from OpenCode events.

Do not add this smoke path to default CI. It depends on local credentials, network availability, and a tool that can mutate the workspace.
