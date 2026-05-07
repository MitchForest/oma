# OMA GitHub PR Review

This example turns a GitHub pull request into an OMA outcome and publishes a low-noise review back to the PR.

OMA provides the durable execution layer: objective, session, harness, environment, artifacts, validation, outcome, and CLI inspection. This example provides the GitHub glue: event parsing, PR context fetch, review objective construction, finding parsing, comment planning, and GitHub publishing.

## Status

This is a POC, not a core package. It must not introduce GitHub assumptions into `@oma/runtime`, `@oma/project`, `@oma/cli`, `@oma/server`, sessions, environments, harnesses, or validators.

If this example exposes a missing core abstraction, stop and write a proposal before changing core packages.

## Trigger

Supported PR comments:

```text
oma review
oma review verbose=true
bugbot run
cursor review
```

## Local Fixture Run

```sh
bun run examples/github-pr-review/src/index.ts -- --fixture examples/github-pr-review/fixtures/basic --dry-run
```

This reads fixture PR metadata and diff, runs OMA with the mock harness, writes `.oma` artifacts, validates them, and prints the GitHub operations it would publish.

## Real Review Harness

Non-fixture runs use an example-local OpenAI read-only review harness.

The model can use these tools:

```text
list_files
read_file
grep
git_diff
```

The model does not receive a write tool. The harness code writes only the required `.oma` review artifacts after the model returns structured findings.

Required environment:

```sh
export OPENAI_API_KEY="..."
export GITHUB_TOKEN="..."
export GITHUB_REPOSITORY="owner/repo"
export GITHUB_EVENT_PATH="/path/to/issue_comment_event.json"
```

Optional:

```sh
export OPENAI_MODEL="gpt-5.5"
export OPENAI_REASONING_EFFORT="medium"
```

Reasoning effort may be `low`, `medium`, `high`, or `xhigh`. The default is `medium`, which is the balanced point for PR review latency and quality.

## Review Config

The POC keeps review policy example-local in `examples/github-pr-review/review.config.json`.

```json
{
  "maxInlineComments": 10,
  "inlineRisk": ["high"],
  "inlineConfidence": ["high", "medium"],
  "excludePaths": ["dist/**", "node_modules/**", "bun.lock"],
  "instructionFiles": [".oma/pr-review.md", "AGENTS.md", "CLAUDE.md", ".cursor/BUGBOT.md"]
}
```

`maxInlineComments`, `inlineRisk`, `inlineConfidence`, and `excludePaths` control GitHub comment noise. Findings that do not pass those gates still remain in `.oma/pr-review-findings.json` and `.oma/pr-review-findings.md`.

Use `--review-config <path>` to point at a different JSON config. Relative config paths are resolved from the example root.

## Repo Instructions

The reviewer reads optional repository instruction files before reviewing:

```text
.oma/pr-review.md
AGENTS.md
CLAUDE.md
.cursor/BUGBOT.md
```

Missing files are ignored. Instruction paths must be repository-relative. These instructions are passed into the read-only review prompt and recorded in `.oma/pr-review-metadata.json` for inspectability.

## GitHub Actions Sketch

```yaml
name: OMA PR Review

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    if: github.event.issue.pull_request && contains(github.event.comment.body, 'oma review')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run examples/github-pr-review/src/index.ts -- --dry-run=false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GITHUB_EVENT_PATH: ${{ github.event_path }}
          GITHUB_REPOSITORY: ${{ github.repository }}
```

The repository includes `.github/workflows/oma-pr-review.yml` as a same-repository PR workflow. Fork PRs are skipped by default because checking out and executing PR code with write-capable GitHub credentials is a different trust boundary.

Add `OPENAI_API_KEY` at:

```text
GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret
```

GitHub supplies `GITHUB_TOKEN` automatically to Actions. The workflow limits it to `contents: read`, `issues: write`, `pull-requests: write`, and `statuses: write`.

## GitHub Lifecycle

The workflow runs trusted reviewer code from the default branch and checks out the PR head into a separate workspace. That lets comment-triggered reviews use the latest reviewer implementation even when the PR being reviewed is older.

On manual triggers, the reviewer:

```text
adds an eyes reaction
posts a pending OMA PR Review commit status on the PR head SHA
upserts a sticky in-progress summary comment
runs the read-only review harness
updates the sticky summary with current findings and lifecycle counts
posts inline comments only for eligible new findings
marks the commit status complete
adds a thumbs-up reaction when no findings are present
```

The sticky summary stores a hidden ledger so later runs can distinguish new, still-open, and resolved findings without reposting the same inline comment.

When findings are present, the summary points to `.oma/pr-review-fix-prompts.md`. That artifact is the handoff surface for Codex, Claude Code, OpenCode, or a human; the reviewer does not make commits or apply fixes automatically.

## Output Artifacts

```text
.oma/pr-review-metadata.json
.oma/pr-review-diff.patch
.oma/pr-review-objective.json
.oma/pr-review-config.json
.oma/pr-review-summary.md
.oma/pr-review-findings.json
.oma/pr-review-findings.md
.oma/pr-review-fix-prompts.md
```

Use the normal OMA CLI to inspect the run:

```sh
bun run packages/cli/src/index.ts runs
bun run packages/cli/src/index.ts inspect <run-id>
bun run packages/cli/src/index.ts events <run-id>
```

## API Pressure Report

Current public APIs are enough for the POC scaffold:

- `Objective` can express the review task.
- `harnesses.custom` lets the example wrap a read-only review harness and collect PR-review artifacts.
- `@oma/project` exposes project loading, factories, and outcome writing.
- Existing validators can require artifacts and validate a minimal findings JSON shape.

Pressure points to keep watching:

- The read-only reviewer currently lives in the example. Promote only if more examples need the same harness shape.
- Review config and repository instruction loading remain example-local. Promote only if multiple templates need the same application config pattern.
- Large diffs may eventually need filesystem-backed artifact references instead of inline artifact content.
- Rich finding validation may eventually need stronger schema support.
