# Codex CLI Harness Smoke Test

This smoke test verifies that `@oma/harness-codex-cli` can drive a real Codex CLI process in a trusted local workspace.

## Requirements

- Bun dependencies installed with `bun install`.
- Codex CLI installed and available on `PATH`.
- Codex CLI authenticated with either `codex --login` or an `OPENAI_API_KEY`.
- A workspace where it is acceptable for Codex to write files.

OpenAI documents `npm install -g @openai/codex` as the CLI install command, `codex --upgrade` as the update path, and `codex --login` as the ChatGPT sign-in flow.

## Manual Smoke

From the OMA repository root:

```sh
codex --version
bun test packages/harnesses/codex-cli/test/codex-cli.test.ts
```

Then run a real OMA harness invocation against a disposable workspace:

```sh
mkdir -p /tmp/oma-codex-smoke
mkdir -p .oma
cat > .oma/codex-smoke.ts <<'EOF'
import { localEnvironment } from "@oma/environment-local";
import { codexCliHarness } from "@oma/harness-codex-cli";
import { objective, outcomes, run, sessions, validators } from "@oma/runtime";

const session = sessions.ephemeral();
const environment = localEnvironment({ workspace: "/tmp/oma-codex-smoke" });

const outcome = await run({
  objective: objective({
    goal: "Write a concise final report that says OMA Codex smoke passed.",
    constraints: ["Do not make code changes"],
    success: ["The final Codex report exists"],
  }),
  process: {
    session,
    harness: codexCliHarness({
      includePatch: false,
      skipGitRepoCheck: true,
      timeoutMs: 120_000,
    }),
  },
  environment,
  validation: [validators.artifactExists(".oma/codex-report.md")],
});

await outcomes.write(outcome, {
  environment,
  session,
  jsonPath: ".oma/outcome.json",
  markdownPath: ".oma/outcome.md",
});

console.log(outcome.status);
EOF

bun run .oma/codex-smoke.ts
cat /tmp/oma-codex-smoke/.oma/outcome.md
```

Expected result:

- The command prints `succeeded`.
- `.oma/codex-objective.md` contains the rendered OMA objective.
- `.oma/codex-report.md` contains the Codex final report.
- `.oma/outcome.md` includes the normalized OMA outcome.

Do not add this smoke path to default CI. It depends on local credentials, network availability, and a tool that can mutate the workspace.
