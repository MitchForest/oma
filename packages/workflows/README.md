# @oma/workflows

Declarative workflow files: one YAML document that binds a trigger, inline
agents, a prompt, and policy over the durable OMA substrate. The file is the
whole product — there is no separate profile artifact. A workflow with a
trigger is an automation; the same file also runs manually.

```yaml
# .oma/workflows/pr-review.yml
name: pr-review
title: Review every pull request

trigger:
  on: github:pull_request.opened
  also:
    - github:pull_request.synchronize
  filter:
    payload.draft: false
  session: "review:{payload.repo}#{payload.pr}"

agent:
  prompt: You review pull requests. Comment only on concrete, actionable issues.
  tools: [get_diff, get_prior_comments, post_inline_comment, post_review, read_file]
  model: claude-code:opus # or codex:gpt-5.5#medium, a provider model name, or module://pkg#export

prompt: |
  Review pull request {payload.pr} in {payload.repo}.

policy:
  maxSteps: 32
  effects:
    post_review: allow
    post_inline_comment: { max: 20, dedupe: true }
    "*": deny
```

Run it:

```bash
oma workflow validate .oma/workflows/pr-review.yml
oma serve webhooks                 # serves every workflow in .oma/workflows/
oma run pr-review                  # manual run of the same file
```

## Semantics

- **Triggers.** `on` (plus `also`) use the substrate's `source:kind` patterns,
  including wildcards (`github:pull_request.*`). `filter` is an equality map
  over dot paths of the signal (`payload.draft: false`); all entries must
  match. Manual runs bypass the filter.
- **Sessions.** `session` is an interpolation template; the same key means the
  same durable session, so every push to a PR wakes the bot with its own
  prior review in the log. Omit it for a fresh session per run.
- **Prompt.** `{payload.x}`, `{inputs.x}`, `{source}`, `{kind}` interpolate;
  an unresolvable path fails the run rather than leaving a hole in the prompt.
- **Inputs.** Declared under `inputs` with `required`/`default`; passed to
  manual runs as repeated `--input key=value`. Undeclared inputs are errors.
- **Events.** Loading and running are recorded in the session log:
  `workflow.loaded` once at spawn, `workflow.run.started` on every routed
  signal — both carry the sha256 of the workflow source, so the log states
  exactly which version of the file handled each signal.
- **Agents are inline.** `agent: {prompt, instructions, tools, sandbox,
  model}` at the workflow level, overridable per stage — a stage's agent is
  complete and replaces the default (partial reuse is what `use:`/`extends:`
  are for). `instructions:` lists markdown files appended to the prompt.
- **Strictness.** Unknown fields are rejected with nearest-field hints
  (`fitler` → `filter`). An unattended automation must not silently ignore a
  typo.

## Stages, models, and loops

A workflow can declare `stages` instead of a single prompt. Each stage is its
own durable session with its own agent and model; the parent session records
the orchestration trace. This is the vision-file shape (runnable offline at
`examples/issue-to-pr-demo/`):

```yaml
name: issue-to-pr
inputs:
  issue: { required: true }

agent:                             # default agent for stages without their own
  prompt: You implement approved plans with small, focused changes.
  tools: [read_file, write_file, bash, git_diff, run_tests]

stages:
  plan:
    agent:
      prompt: You plan minimal, reviewable fixes.
      tools: [read_file, search]
      model: claude-fable-5
    approve: true                  # pauses until `oma approve <session>`
    prompt: Plan a minimal fix for issue {inputs.issue}.
    output: { summary: string }
  execute:
    prompt: "Implement the approved plan: {stages.plan.summary}"
    reprompt: |                    # sent on later loop iterations instead
      The reviewer requested changes: {stages.review.feedback}
      Address every point.
    output: { summary: string }
  review:
    agent:
      prompt: You review implementations against their plan, strictly.
      tools: [read_file, git_diff, run_tests]
      model: claude-fable-5        # judge with a different model
    prompt: "Review: {stages.execute.summary}"
    output:
      verdict: approve | revise
      feedback: string

loop:
  over: [execute, review]
  until: review.verdict == approve
  max: 3
```

Semantics:

- **Stage sessions are durable and per-stage** (`<parent>/execute`): iteration
  two wakes the *same* executor conversation with the judge's feedback, so the
  executor keeps its own working context across revisions.
- **Structured outputs.** `output` declares fields (`string`, `number`,
  `boolean`, or `a | b` enums); the runner instructs the model to end with a
  fenced json block, validates it, and retries once with a corrective message
  before failing the stage. Outputs are recorded on
  `workflow.stage.completed` and drive `{stages.<name>.<field>}`
  interpolation and `loop.until`.
- **Loops are deterministic.** `until` is exactly
  `<stage>.<field> == literal` (or `!=`), evaluated by the runner, not a
  model; `max` is a hard stop recorded as `workflow.run.completed`
  status `max-iterations`.
- **Approvals are durable events.** `approve: true` pauses the run with
  `human.approval.requested`; `oma approve <session>` / `oma deny <session>`
  append the decision and resume. A killed process resumes from the log —
  **a completed stage never re-executes**, the same invariant recorded tool
  results have.
- **Resume** with `oma wake <parentSession>` at any time.

## Effects, budgets, and secrets

An unattended workflow's blast radius is readable from its YAML:

```yaml
policy:
  effects:
    post_review: allow
    post_inline_comment: { max: 20, dedupe: true }
    merge_pr: deny
    write_file: approve
  budget:
    tokens: 2M
    wall: 30m

env:
  secrets:
    GITHUB_TOKEN: keychain://oma/github-token
  expose: [GITHUB_TOKEN]        # only these names reach the sandbox env
```

- **Effects are enforced by the harness at execution time**, outside the
  model. Keys are tool-name patterns (exact, `post_*`, `*`); exact beats
  longest-prefix beats catch-all. With an effects block present, reads are
  allowed by default and every other tool must be declared. `deny` becomes a
  `tool.error` the model can read and adapt to — it can never execute.
  `approve` records the call durably with its exact args, requests approval,
  and pauses the run; `oma approve <session>` / `oma deny <session>` decide
  and resume. `max` caps real executions per session; `dedupe` returns the
  recorded result for an identical repeated call instead of re-executing.
- **Budgets are hard stops, not suggestions.** Token ceilings count recorded
  model usage (across every stage session in staged workflows); wall clocks
  anchor at `workflow.run.started` so resumes keep the original deadline. A
  tripped budget pauses with the accounting in the reason
  (`budget:tokens (used 2000 of 1500)`); resume re-reads the workflow file,
  so raising the budget in YAML and waking continues the run — and the
  recorded source hash states which version allowed it.
- **Secrets are references, resolved harness-side** (`env://VAR`,
  `file:///path`, `keychain://service/account`). Values feed tool clients by
  name and reach the sandbox environment only when listed under `expose`;
  they never enter session events or model context, and errors name the ref,
  not the value.

Runnable demos: `examples/issue-to-pr-demo/effects-demo.yml`,
`budget-demo.yml`, `env-demo.yml`.

## Placement: `runs_on` and workers

Stages declare where they run; workers are the same stateless harness pointed
at the same store:

```yaml
stages:
  plan:
    prompt: ...            # no runs_on: runs wherever orchestration is
  execute:
    runs_on: worker:mac-mini
    prompt: ...
```

```bash
oma run placed-demo --input issue=7   # plans locally, then pauses:
# reason  Stage "execute" is dispatched to worker:mac-mini — run: oma worker --name mac-mini

# on the mac mini (same store, its own checkout of the repo):
oma worker --name mac-mini            # claims the session, finishes the loop
oma tail <session>                    # watch live from anywhere (postgres store)
```

Orchestration is itinerant: the stage runner is a pure function of the parent
log, so "dispatching" a stage just records `workflow.stage.dispatched` and
pauses — whichever worker matches resumes the same log and continues.
Durable **run claims** (a lease per session, renewed while work runs) keep the
CLI and any number of workers from double-waking a session: a claim held by a
live worker refuses others by name, a dead worker's lease expires, and any
other worker takes over from the log **with zero re-executed stages** — the
same replay invariant everything else rests on. Stores with claims (memory,
sqlite, postgres) get this automatically; `oma wake` on a claimed session
tells you who holds it.

Demo: `examples/issue-to-pr-demo/placed-demo.yml`.

## Context packs

`context:` declares exactly what the model is shown, with a hard budget:

```yaml
context:
  include: ["src/**", "docs/architecture.md"]
  exclude: ["**/*.test.ts"]
  map: ["docs/**"]        # signature-level codemaps, ~5-10% of body cost
  budget: 120k            # chars/4 token estimate
```

Works at the workflow top level and per stage (`stages.<name>.context`
overrides). Globs resolve against the working directory — the environment the
runtime operates in — not the workflow file's location.

- **Deterministic selection and fit.** Files sort by path; over budget, the
  largest full-body files demote to codemaps first, then files drop
  largest-first. Same tree, same pack, same `packId`.
- **The log records what the model saw and why it fit.** Every prompt render
  appends `context.pack.built` — per-file hash, mode, token estimate,
  demotions, drops with reasons — before the message carrying the rendered
  `<context>` section. Staged loops rebuild per iteration, so reviewers see
  the executor's current file state.
- **Freshness.** Hashes are of the full file regardless of rendered mode;
  `findStaleContextFiles` reports drift between a recorded pack and the tree.
- **Codemaps are heuristic** (top-level TS/JS signatures, markdown headings,
  head-of-file fallback) — the format is stable, grammar-backed extraction
  can replace the extractor later.
- **Preview without running:** `oma workflow context <path> [--stage <n>]`.

Demo: `examples/issue-to-pr-demo/context-demo.yml`.

## Composing workflows (`extends:` and `use:`)

```yaml
name: strict-review
extends: base-review.yml        # inherit; child fields win
policy:
  effects:
    post_review: allow          # merges per pattern with the base's effects

stages:
  review:
    use: "stages/common.yml#judge"   # shared stage definition; local fields override
    model: cheaper-judge
```

Merge rules are explicit: scalars and arrays are replaced by the child; the
maps (`stages`, `inputs`, `policy.effects`, `env.secrets`, `trigger`,
`context`) merge per key; stage entries merge field-by-field. Composition
resolves before validation, so the merged document is what the strict schema
checks — and the child file's hash is what the log records. Cycles and
missing bases are authoring errors with named diagnostics.

## Code workflows (`run:`)

When coordination outgrows `stages` order + `loop` — tournaments, conditional
branches, fan-out — point `run:` at a module and keep the stages declared:

```yaml
run: workflows/coordinate.ts
stages: { plan: ..., execute: ..., review: ... }
```

```ts
export default async function ({ stage, inputs }) {
  await stage("plan");                       // approve-gated
  let verdict;
  do {
    await stage("execute");
    verdict = (await stage("review")).verdict;
  } while (verdict !== "approve");
}
```

The nth `stage("x")` call is iteration n. On resume the module re-executes
from the top and completed iterations replay from the log without re-running,
so pauses and crashes are safe — provided the module is deterministic (same
`stage()` sequence for the same inputs; no `Date.now()`-dependent branching).

## API

```ts
import {
  loadWorkflowDocument,   // parse + validate + hash + compile inline agents
  requireLoadedWorkflow,  // throwing variant
  listWorkflowFiles,      // .oma/workflows/*.{yml,yaml,json}
  resolveWorkflowName,    // "pr-review" -> .oma/workflows/pr-review.yml
  compileWorkflow,        // -> TriggerDefinitions + workflow events
  manualTriggerSignal,    // inputs -> manual:run signal
  resolveWorkflowInputs   // defaults + required checks
} from "@oma/workflows";
```

`compileWorkflow` produces plain `TriggerDefinition`s plus `spawnEvents` /
`signalEvents` for `routeTriggerSignal` — no new runtime semantics; the
workflow file is a binding document over existing primitives.

Getting started from nothing: `oma templates`, `oma init --template
pr-review`, `oma skill install` (teaches Claude Code and friends to drive
all of this). See `.docs/plan.md` for what comes after the six milestones.
