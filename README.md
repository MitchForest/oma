# OMA

OMA is an open outcome runtime for long-running agents.

Given an objective, OMA runs a durable process in a pluggable environment, produces artifacts, validates them, and returns an inspectable outcome.

The project is starting as a small TypeScript runtime, not a SaaS platform, chat app, workflow builder, or agent persona framework.

## Development

Install dependencies:

```sh
bun install
```

Verify the workspace:

```sh
bun run verify
```

## Package Naming

The first public package is `@oma/runtime`. Additional packages should only be split out when the runtime contract makes the boundary necessary.

## Phase 1 API

```ts
import {
  artifacts,
  environments,
  harnesses,
  objective,
  run,
  sessions,
  validators,
} from "@oma/runtime";

const outcome = await run({
  objective: objective({
    goal: "Produce a report",
    constraints: ["Do not mutate external systems"],
    success: ["A report artifact exists"],
  }),
  process: {
    session: sessions.ephemeral(),
    harness: harnesses.mock({
      artifacts: [artifacts.report("result.md", "Done.")],
    }),
  },
  environment: environments.none(),
  validation: [validators.artifactExists("result.md")],
});

console.log(outcome.status);
```

Phase 1 intentionally has no Docker, GitHub, database, LLM provider, web server, CLI, or UI dependency.

## Phase 2 Durable Sessions

```ts
import {
  artifacts,
  environments,
  harnesses,
  objective,
  replayOutcome,
  resume,
  run,
  sessions,
  validators,
} from "@oma/runtime";

const store = sessions.jsonl({ dir: ".oma/sessions" });
const session = await store.create();

await run({
  objective: objective({ goal: "Produce a report" }),
  process: {
    session,
    harness: harnesses.mock({
      artifacts: [artifacts.report("result.md", "Done.")],
    }),
  },
  environment: environments.none(),
  validation: [validators.artifactExists("result.md")],
});

const reopened = await store.open(session.id);
const replayed = await replayOutcome(reopened);

if (replayed.ok) {
  console.log(replayed.outcome.status);
}

await resume({
  objective: objective({ goal: "Produce a report" }),
  process: {
    session: reopened,
    harness: harnesses.mock(),
  },
  environment: environments.none(),
  validation: [validators.artifactExists("result.md")],
});
```

SQLite persistence lives in `@oma/session-sqlite`:

```ts
import { sqliteSessions } from "@oma/session-sqlite";

const store = sqliteSessions({ path: ".oma/sessions.db" });
```

`@oma/session-sqlite` is currently Bun-backed via `bun:sqlite`.

## Phase 3 Local Environment

Local command, filesystem, and git capabilities live in `@oma/environment-local`:

```ts
import { localEnvironment } from "@oma/environment-local";
import { artifacts, harnesses, objective, run, sessions } from "@oma/runtime";

const outcome = await run({
  objective: objective({ goal: "Use the local workspace" }),
  process: {
    session: sessions.ephemeral(),
    harness: harnesses.fromFn(async ({ environment }) => {
      const result = await environment.shell?.exec({
        command: "echo",
        args: ["hello"],
      });

      await environment.filesystem?.writeText("result.txt", result?.stdout ?? "");

      return {
        artifacts: [artifacts.log("command.log", result?.stdout ?? "")],
      };
    }),
  },
  environment: localEnvironment({
    workspace: process.cwd(),
  }),
});

console.log(outcome.status);
```

The local environment is not a security boundary. Use it only for trusted workspaces.

## Phase 4 Inspectable Outcomes

```ts
import { localEnvironment } from "@oma/environment-local";
import {
  collectors,
  harnesses,
  objective,
  outcomes,
  run,
  sessions,
  validators,
} from "@oma/runtime";

const session = sessions.ephemeral();
const environment = localEnvironment({ workspace: process.cwd() });

const outcome = await run({
  objective: objective({ goal: "Produce inspectable output" }),
  process: {
    session,
    harness: harnesses.fromFn(async ({ environment }) => {
      await environment.filesystem?.writeText("report.md", "Done.");

      return {
        artifacts: [
          await collectors.report("report.md").collect({ environment }),
          await collectors.gitDiff("changes.patch").collect({ environment }),
        ],
      };
    }),
  },
  environment,
  validation: [
    validators.artifactExists(["report.md", "changes.patch"]),
    validators.command({ command: "bun", args: ["test"] }),
  ],
});

await outcomes.write(outcome, {
  environment,
  session,
  jsonPath: ".oma/outcome.json",
  markdownPath: ".oma/outcome.md",
});
```

## Phase 5 Harness Adapters

Real harness adapters live outside the runtime. `@oma/harness-codex-cli` drives `codex exec`:

```ts
import { localEnvironment } from "@oma/environment-local";
import { codexCliHarness } from "@oma/harness-codex-cli";
import { objective, run, sessions, validators } from "@oma/runtime";

const outcome = await run({
  objective: objective({
    goal: "Make the requested code change and write a final report",
    constraints: ["Keep the diff focused"],
    success: ["A final report exists"],
  }),
  process: {
    session: sessions.ephemeral(),
    harness: codexCliHarness({
      skipGitRepoCheck: true,
      timeoutMs: 120_000,
    }),
  },
  environment: localEnvironment({
    workspace: process.cwd(),
  }),
  validation: [validators.artifactExists(".oma/codex-report.md")],
});

console.log(outcome.status);
```

The adapter renders an OMA objective for `codex exec`, writes it to `.oma/codex-objective.md`, asks Codex to write `.oma/codex-report.md`, and can collect a git patch artifact when the environment exposes git. Harness logs are regular OMA log artifacts; Codex-specific details do not enter core runtime types.

See `docs/smoke/codex-cli.md` for the manual smoke test. It is intentionally not part of default CI because it requires local credentials, network access, and a trusted mutable workspace.

`@oma/harness-pi` drives Pi in JSON event-stream mode:

```ts
import { localEnvironment } from "@oma/environment-local";
import { piHarness } from "@oma/harness-pi";
import { objective, run, sessions, validators } from "@oma/runtime";

const outcome = await run({
  objective: objective({
    goal: "Make the requested code change and write a final report",
    constraints: ["Keep the diff focused"],
    success: ["A final report exists"],
  }),
  process: {
    session: sessions.ephemeral(),
    harness: piHarness({
      timeoutMs: 120_000,
    }),
  },
  environment: localEnvironment({
    workspace: process.cwd(),
  }),
  validation: [validators.artifactExists(".oma/pi-report.md")],
});

console.log(outcome.status);
```

The Pi adapter renders `.oma/pi-objective.md`, asks Pi to write `.oma/pi-report.md`, collects `.oma/pi-events.jsonl` as evidence, and maps provider-specific JSONL events into small `harness.observed` OMA events. Pi sessions remain harness-private; OMA sessions remain the durable outcome ledger.

See `docs/smoke/pi.md` for the manual smoke test. It is intentionally not part of default CI for the same reason as the Codex smoke path.

`@oma/harness-opencode` drives OpenCode through `opencode run --format json`:

```ts
import { localEnvironment } from "@oma/environment-local";
import { opencodeHarness } from "@oma/harness-opencode";
import { objective, run, sessions, validators } from "@oma/runtime";

const outcome = await run({
  objective: objective({
    goal: "Make the requested code change and write a final report",
    constraints: ["Keep the diff focused"],
    success: ["A final report exists"],
  }),
  process: {
    session: sessions.ephemeral(),
    harness: opencodeHarness({
      timeoutMs: 120_000,
    }),
  },
  environment: localEnvironment({
    workspace: process.cwd(),
  }),
  validation: [validators.artifactExists(".oma/opencode-report.md")],
});

console.log(outcome.status);
```

The OpenCode adapter renders `.oma/opencode-objective.md`, asks OpenCode to write `.oma/opencode-report.md`, collects `.oma/opencode-events.jsonl` as evidence, and maps recognizable OpenCode JSON events into `harness.observed` OMA events. OpenCode agents, permissions, snapshots, MCP, plugins, and server/ACP modes remain harness configuration rather than core runtime concepts.

See `docs/smoke/opencode.md` for the manual smoke test. It is intentionally not part of default CI for the same reason as the other real harness smoke paths.

`@oma/harness-claude-code` drives Claude Code through `claude -p --output-format stream-json`:

```ts
import { localEnvironment } from "@oma/environment-local";
import { claudeCodeHarness } from "@oma/harness-claude-code";
import { objective, run, sessions, validators } from "@oma/runtime";

const outcome = await run({
  objective: objective({
    goal: "Make the requested code change and write a final report",
    constraints: ["Keep the diff focused"],
    success: ["A final report exists"],
  }),
  process: {
    session: sessions.ephemeral(),
    harness: claudeCodeHarness({
      permissionMode: "acceptEdits",
      timeoutMs: 120_000,
    }),
  },
  environment: localEnvironment({
    workspace: process.cwd(),
  }),
  validation: [validators.artifactExists(".oma/claude-report.md")],
});

console.log(outcome.status);
```

The Claude Code adapter renders `.oma/claude-objective.md`, asks Claude Code to write `.oma/claude-report.md`, collects `.oma/claude-events.jsonl` as evidence, and maps system, assistant, result, stream, tool-use, hook, and usage events into `harness.observed` OMA events. Claude settings, tools, MCP, skills, hooks, agents, sessions, and permission modes remain adapter configuration rather than runtime concepts.

See `docs/smoke/claude-code.md` for the manual smoke test. It is intentionally not part of default CI for the same reason as the other real harness smoke paths.

## Known V0 Limits

- Outcome objects include the full event array in memory.
- JSONL sessions serialize appends within one process, but do not provide cross-process file locking.
- Event schema v1 rejects unsupported versions during replay; migrations are not implemented yet.
- The local environment is not a security boundary. It is for trusted workspaces only.
