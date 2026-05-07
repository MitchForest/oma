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
export OPENAI_MODEL="gpt-5"
```

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

GitHub supplies `GITHUB_TOKEN` automatically to Actions. The workflow limits it to `contents: read`, `issues: write`, and `pull-requests: write`.

## Output Artifacts

```text
.oma/pr-review-metadata.json
.oma/pr-review-diff.patch
.oma/pr-review-objective.json
.oma/pr-review-summary.md
.oma/pr-review-findings.json
.oma/pr-review-findings.md
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
- Large diffs may eventually need filesystem-backed artifact references instead of inline artifact content.
- Rich finding validation may eventually need stronger schema support.
