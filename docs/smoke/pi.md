# Pi Harness Smoke Test

This smoke test verifies that `@oma/harness-pi` can drive a real Pi process in JSON event-stream mode from a trusted local workspace.

## Requirements

- Bun dependencies installed with `bun install`.
- Pi installed and available on `PATH`.
- Pi authenticated with `/login` or an API key environment variable for the selected provider.
- A workspace where it is acceptable for Pi to write files and run commands.

Pi is distributed as `@mariozechner/pi-coding-agent`. Pi documents `--mode json` for JSONL event output, `--mode rpc` for process integration, `--no-session` for ephemeral mode, `--provider` and `--model` for model selection, and `--tools` for tool allowlists.

## Manual Smoke

From the OMA repository root:

```sh
pi --version
bun test packages/harnesses/pi/test/pi.test.ts
```

Then run a real OMA harness invocation against a disposable workspace:

```sh
mkdir -p /tmp/oma-pi-smoke
mkdir -p .oma
cat > .oma/pi-smoke.ts <<'EOF'
import { localEnvironment } from "@oma/environment-local";
import { piHarness } from "@oma/harness-pi";
import { objective, outcomes, run, sessions, validators } from "@oma/runtime";

const session = sessions.ephemeral();
const environment = localEnvironment({ workspace: "/tmp/oma-pi-smoke" });

const outcome = await run({
  objective: objective({
    goal: "Write a concise final report that says OMA Pi smoke passed.",
    constraints: ["Do not make code changes"],
    success: ["The final Pi report exists"],
  }),
  process: {
    session,
    harness: piHarness({
      includePatch: false,
      timeoutMs: 120_000,
      extraArgs: ["--no-context-files"],
    }),
  },
  environment,
  validation: [validators.artifactExists(".oma/pi-report.md")],
});

await outcomes.write(outcome, {
  environment,
  session,
  jsonPath: ".oma/outcome.json",
  markdownPath: ".oma/outcome.md",
});

console.log(outcome.status);
EOF

bun run .oma/pi-smoke.ts
cat /tmp/oma-pi-smoke/.oma/outcome.md
```

Expected result:

- The command prints `succeeded`.
- `.oma/pi-objective.md` contains the rendered OMA objective.
- `.oma/pi-report.md` contains the Pi final report.
- `.oma/pi-events.jsonl` is collected as a log artifact.
- `.oma/outcome.md` includes normalized OMA observations from Pi events.

Do not add this smoke path to default CI. It depends on local credentials, network availability, and a tool that can mutate the workspace.
