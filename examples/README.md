# OMA Reference Examples

These examples are runnable proofs of OMA's core claims. They are deterministic by
default and do not require network access or API keys.

Run the catalog:

```bash
bun packages/cli/src/index.ts examples list
bun packages/cli/src/index.ts examples list --json
```

| Example | Claim | Command | Network |
|---|---|---|---|
| `minimal-replay` | Recorded tool results are not re-executed. | `bun packages/cli/src/index.ts examples minimal-replay --json` | No |
| `pr-review-simulated` | One PR maps to one durable idempotent review session. | `bun packages/cli/src/index.ts examples pr-review-simulated --json` | No |
| `local-coding-agent` | A local coding agent is a profile plus tools, sandbox, and session log. | `bun packages/cli/src/index.ts examples local-coding-agent --json` | No |
| `background-job` | A headless job uses the same durable agent substrate. | `bun packages/cli/src/index.ts examples background-job --json` | No |
| `forked-approaches` | Forks share history and then diverge independently. | `bun packages/cli/src/index.ts examples forked-approaches --json` | No |
| `multiplayer-viewer` | Multiple subscribers observe the same live session in order. | `bun packages/cli/src/index.ts examples multiplayer-viewer --json` | No |
| `mcp-import` | MCP stdio servers can become OMA tools without changing core. | `bun packages/cli/src/index.ts examples mcp-import --json` | No |
| `github-pr-review-webhook` | GitHub webhooks are thin trigger signals for PR review profiles. | `bun packages/cli/src/index.ts examples github-pr-review-webhook --json` | No |

Each JSON result includes:

```json
{
  "example": "minimal-replay",
  "claim": "recorded tool results are not re-executed",
  "status": "passed"
}
```

The examples are intentionally small. If a new product requires changing core to be
expressed as an example, that is a contract smell worth investigating.
