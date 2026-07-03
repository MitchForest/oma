---
name: oma
description: Create and operate durable OMA workflows — declarative YAML automations (bugbots, issue-to-PR loops, incident responders) that outlive your session, run on triggers or remote workers, and record every step in a replayable log. Use when the user wants a recurring automation, a PR review bot, a plan/execute/review loop, an incident-to-fix flow, or asks to "use oma".
---

# OMA: durable workflow automations

OMA runs agents as durable, replayable session logs. You (the coding agent)
are the front door: plan with the user, write or install a workflow YAML,
validate it, run it, and hand the user the commands to watch and approve.
The workflow keeps running after this session ends.

Run every command below with `oma` (or `bun packages/cli/src/index.ts` from
an OMA checkout when no binary is installed).

## Fast path: install a template

```bash
oma templates                       # list: pr-review, issue-to-pr, incident-to-pr, nightly-triage
oma init --template pr-review       # scaffolds .oma/, installs + validates the workflow, prints next steps
```

Templates land as one file: `.oma/workflows/<name>.yml`. Tell the user to
commit it (it is the reviewable automation) and show them the printed next
steps (credentials, webhooks). Always show the user the installed workflow
YAML and get their explicit OK before serving it.

## Authoring a workflow from scratch

Write `.oma/workflows/<name>.yml`. The schema is strict — unknown fields are
rejected with hints, so iterate with:

```bash
oma workflow validate .oma/workflows/<name>.yml
```

The full shape (all blocks optional unless noted):

```yaml
name: issue-to-pr                    # required
title: Issue in, reviewed change out

trigger:                             # omit for manual-only workflows
  on: github:pull_request.opened     # source:kind, wildcards like github:pull_request.*
  also: [github:pull_request.synchronize]
  filter: { payload.draft: false }   # equality match on signal dot-paths
  session: "review:{payload.repo}#{payload.pr}"   # same key = same durable session

inputs:                              # for manual runs: --input issue=412
  issue: { required: true }

agent:                               # the default agent, defined inline
  prompt: You implement approved plans with small, focused changes.
  instructions: [style.md]           # optional markdown appended to the prompt
  tools: [read_file, write_file, bash, git_diff, run_tests]
  sandbox: worktree                  # local (default) | worktree | {kind: docker, image: …}
  model: codex:gpt-5.5#medium        # see model routing below

prompt: |                            # single-stage form (XOR with stages:)
  Review pull request {payload.pr} in {payload.repo}.

stages:                              # multi-stage form; each stage = its own durable session
  plan:
    agent:                           # a stage's agent is complete: it replaces
      prompt: You plan minimal fixes.  # the default, never merges with it
      tools: [read_file, search]
      model: claude-code:opus        # different model per stage is normal
    approve: true                    # pauses until `oma approve <session>`
    prompt: Plan a fix for {inputs.issue}.
    output: { summary: string }      # validated structured output
  execute:
    runs_on: worker:mac-mini         # runs on `oma worker --name mac-mini` (same store)
    prompt: "Implement: {stages.plan.summary}"
    reprompt: |                      # later loop iterations get this instead
      Reviewer feedback: {stages.review.feedback}
    output: { summary: string }
  review:
    use: "stages/common.yml#judge"   # pull a shared stage definition; local fields override
    prompt: "Review: {stages.execute.summary}"
    output: { verdict: approve | revise, feedback: string }

loop:
  over: [execute, review]            # contiguous stages, re-run until…
  until: review.verdict == approve   # deterministic condition, no model involved
  max: 3

context:                             # exactly what the model is shown, recorded in the log
  include: ["src/**"]
  exclude: ["**/*.test.ts"]
  map: ["docs/**"]                   # signature-level codemaps (~5-10% token cost)
  budget: 120k                       # hard ceiling; preview: oma workflow context <path>

policy:
  maxSteps: 32
  onToolError: continue              # continue (default) | fail
  effects:                           # enforced by the harness, not the model
    post_review: allow
    post_inline_comment: { max: 20, dedupe: true }
    write_file: approve              # pauses; user decides with oma approve/deny
    "*": deny                        # reads stay allowed; undeclared writes denied
  budget: { tokens: 2M, wall: 30m }  # resumable hard stops

env:
  secrets:                           # refs resolved harness-side, never logged
    GITHUB_TOKEN: env://GITHUB_TOKEN # also file:///path, keychain://service/account
  expose: [GITHUB_TOKEN]             # only these reach the sandbox env

extends: base.yml                    # inherit another workflow; child fields win
```

Rules of thumb:
- One file is the whole product: agents are defined inline, there is no
  separate profile artifact. Reuse comes from `extends:` and stage `use:`.
- Interpolation: `{inputs.x}`, `{payload.x}`, `{stages.<name>.<field>}` — an
  unresolvable path fails the run rather than sending a prompt with a hole.
- `session:` is identity: keyed sessions are woken (with their history) by
  repeat triggers instead of spawning new ones. That is how a bugbot
  remembers its own comments.
- Effects are the blast radius the user reviews. Automations should declare
  `"*": deny` plus explicit allows; anything scary gets `approve`.
- `module://` models (like `run:` code workflows) execute code — point them
  only at packages the user trusts.

## Running and operating

```bash
oma run <name> --input k=v           # manual run (bare names resolve in .oma/workflows)
oma workflow context <path>          # preview the context pack without running
oma list                             # sessions with real statuses
oma show <sessionId> [--events]      # the full durable trace
oma tail <sessionId>                 # follow live
oma approve <sessionId> [--note …]   # decide a paused stage gate or tool approval
oma deny <sessionId> [--reason …]
oma wake <sessionId>                 # resume anything (re-reads the YAML: edits apply)
oma send <sessionId> <message>       # chat with a single-stage workflow session
GITHUB_WEBHOOK_SECRET=… oma serve webhooks   # serve every workflow in .oma/workflows
oma worker --name mac-mini           # execute stages marked runs_on: worker:mac-mini
```

Model routing (the `model:` string, per agent):
- `claude-code:<model>` and `codex:<model>[#<effort>]` ride the Claude Code /
  Codex CLIs the user is **already logged into** — no API keys needed. The
  harness does its own tool use in the working directory (give such agents
  `tools: []`); Codex is contained by its own sandbox, Claude Code runs with
  permissions bypassed — treat these stages like trusted code and prefer a
  scratch checkout or worker for isolation. This is the default choice for
  most users.
- A plain name targets the provider in `.oma/config.json` (`anthropic` |
  `openai-compatible`; needs an API key env). The default `fake` provider
  runs offline for smoke tests.
- `module://<pkg>#<export>` loads a custom provider factory (code execution).

## How to behave

1. Ask what should trigger the automation and what it may touch; pick or
   author accordingly.
2. Prefer a template (`oma init --template …`), then edit.
3. Validate until clean; show the user the final YAML — especially
   `policy.effects` — and get their OK before serving or scheduling it.
4. Dry-run with `oma trigger emit … --payload '{…}'` or `oma run` before
   wiring real webhooks.
5. Hand off with the exact watch/approve commands and where the session logs
   live. Never put secret values in the YAML — refs only.
