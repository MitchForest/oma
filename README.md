# OMA

**Open Managed Agents** — the open substrate for agents that survive, scale, and compound.

```
The agent is a durable, live, forkable log.
The harness is a stateless function over it.
The sandbox is untrusted hands.
The workflow is the product.
```

Most agent harnesses are a process with a state file. OMA is a **durable, live, forkable session log** with a disposable function running on top. That one inversion is the whole project — and it's the difference between an agent you babysit in a terminal and an agent you can close your laptop on, hand to a teammate, fork to try three approaches, point a supervisor at, and wake again tomorrow.

If you've ever wanted to build your own River, Inspect, or Horizon and found yourself rebuilding the same substrate from scratch — this is that substrate, open.

---

## Why this exists

In the last six months, a striking number of teams shipped the same thing under different names:

- **Anthropic** shipped Managed Agents and said the quiet part out loud: separate the *session* (an append-only log of everything that happened) from the *harness* (the disposable loop) from the *sandbox* (untrusted execution). The harness became "cattle" — when it crashes, you `wake(sessionId)`, replay the log, and resume.
- **Shopify** built **Aquifer** under their Slack agent **River** (one in eight merged PRs, ~60k sessions/month). Their design constraint: *cells die, sandboxes die, machines die — the conversation doesn't.* River is "one profile on top of Aquifer." The next agent is a profile, not a platform.
- **Ramp** built **Inspect** (~30–50% of merged PRs) on a durable per-session store with a clean control-plane / data-plane split. You can start a session and resume it from your phone after dinner.
- **WorkOS** built **Horizon**, an event-driven "self-driving codebase," and said plainly they built it in-house — inspired by Ramp and Stripe — because no open version existed.
- **Stripe** built **Minions** (1,300+ PRs/week, zero human-written lines), a fork of Goose extended with deterministic steps.
- **Block** open-sourced **Goose**, proving the *ergonomics* — model-agnostic, MCP-native, hackable — but kept the session local.

Five of these six rebuilt the **same substrate privately.** WorkOS said it out loud: *the pattern is real, the details are company-specific, and there was nothing to adopt.*

**OMA is that substrate, open.** Not a framework with opinions about your model, database, sandbox, or UI. The small set of primitives *underneath* all of them — with two properties the in-house versions stopped short of.

---

## The bet, in one idea

A decade ago, Martin Kleppmann pointed at a database and said: *the log is the database; the indexes, caches, and views are just projections over it.* Agents are at the same moment.

> **The agent is the log. Everything else is a projection or a subscriber.**

Memory? A compressed projection over the log. Context window? A filtered projection. Transcript, audit trail, fork tree, the "what did it decide and why"? All projections. The model doing the thinking is just the current subscriber. When you see it this way, the pile of agent-framework machinery — workflow runners, memory stores, ad-hoc pub/sub, session files — collapses into one primitive with views on top.

The code stays small because the concept stays singular.

---

## What makes OMA different

Two claims. The first is convergent — we extracted it from the systems above. The second is ours.

### 1. The harness is a *stateless function*, and we make that a contract — not a hope

Most "resumable" agents are crash-*recoverable*: if the process dies, you can sort of pick up. OMA goes further and makes statelessness an **enforceable invariant**:

> `step(events) → action` is a pure function of the log. Same events, same next action. No hidden state between calls. **A harness woken from the log is indistinguishable from one that ran the whole session continuously.**

The correctness seam that makes this real: **on replay, recorded tool results are read from the log — never re-executed.** Get this one thing right and `wake`, `fork`, multiplayer, audit, and resume stop being features you build and start being properties you get. Get it wrong and you have a process pretending to be a function. Most naive implementations die here; OMA is built around not dying here.

### 2. The log is *live and forkable*, not just durable

This is the part the in-house systems mostly don't have as a primitive. Anthropic's and Shopify's logs are durable and external — but durability alone gives you "survives a crash." OMA's log is also:

- **Live** — many readers `subscribe` and watch the same agent as events land. Multiplayer and observability fall out for free.
- **Forkable** — `fork(session, offset)` branches a new independent session from any point in history. Try three approaches from the same known-good state without disturbing the original.

Durable gets you *resumable*. **Live + forkable gets you multiplayer, supervisable, and explorable.** That's the unlock.

---

## How this is different from pi, opencode, Goose, Claude Code

These are excellent tools. OMA is not competing on hackability or ergonomics — it's competing on *where the agent lives.*

| | Where state lives | "Live"? | Forkable? | Multiplayer | The unit of a new product |
|---|---|---|---|---|---|
| **pi / Claude Code** | local session file (`~/.pi/...`) | no | copy a file | no | a fork of the tool / config |
| **opencode** | local SQLite + parent/child sessions; sharing bolted on via a Durable Object | sharing only | no | view-only share | config + plugins |
| **Goose** | local session, YAML recipes | no | no | no | a recipe |
| **OMA** | **durable external event log** | **yes, native** | **yes, native** | **by construction** | **a workflow (one YAML file)** |

The sharpest way to see it: **opencode is the closest, and the gap is instructive.** It has a SQLite session store, parent/child session trees, even live session-sharing through a Cloudflare Durable Object. But sessions are *isolated* (no agent learns from the last one), session storage grows unboundedly because it isn't a clean event log, and "live" is a *sharing feature* layered on top — not the substrate the agent runs on. OMA makes the live, append-only log the spine, so liveness, forking, memory-as-projection, and multiplayer aren't features to add — they're consequences of the shape.

> Most harnesses let you **prompt an agent.** OMA lets you **design loops that prompt agents** — because the loop is a durable, observable, forkable object, not a process in your terminal.

And the pi-grade promise still holds: the core stays tiny, and **workflow and tool authors never need to understand the runtime's internals.** If the public API leaks the guts, OMA has stopped being a substrate.

---

## What you can build

OMA is the substrate; these are workflows + adapters on top of it. None require touching the core. Four ship as installable templates (`oma templates`).

**A bugbot.** A `pr-review` workflow triggered by GitHub webhooks, one durable session per pull request — the bot remembers its own prior comments because the session key does. Effects policy caps what it can post; it can never merge.

**An Inspect.** A staged plan/execute/review workflow with an approval gate: plan with one model, execute with another, judge with a third, loop until the judge approves. Close your laptop after approving the plan — a worker on any machine sharing the store finishes the loop (`runs_on: worker:mac-mini`).

**A Horizon.** Sentry triggers that spawn investigate→fix workflows. An alert fires → root cause → an approval-gated fix. The trigger stays dumb; the judgment lives in the workflow's agents; the blast radius is readable in its `policy.effects`.

**A nightly sweep.** A read-only triage workflow run from cron, with a context pack and a hard token budget recorded in the log.

> The test for the substrate: **the next automation should be a new workflow file, not a fork of the platform.** If building one of these needs a new core primitive, the primitive set is wrong.

---

## The primitives

A dozen verbs across four layers. That's the whole surface.

```ts
// Session — the substrate. This IS the agent.
appendEvent(sessionId, event)          // the only write
getSession(sessionId, fromOffset?)     // replay from any point
subscribe(sessionId, fromOffset?)      // LIVE: many readers watch as events land
fork(sessionId, atOffset)              // branch an independent session from history

// Harness — stateless function over the log. Cattle, not a pet.
wake(sessionId)                        // boot fresh, replay to tail, resume — same op as crash recovery
step(events) -> action                 // pure: same events, same action, no hidden state
buildContext(events) -> context        // the context-engineering seam; expect to thin it as models improve

// Sandbox — untrusted, disposable hands. Credentials stay harness-side.
provision(policy) -> sandbox
exec(sandbox, command)                 // calls + results become session events
destroy(sandbox)

// Product surface — what builders actually touch
defineTool({ name, schema, handler })  // observe AND mutate; MCP servers auto-import
spawn(profile, id, initialMessage)     // new agent/product = create session + wake
send(entityId, message)                // append to an inbox; human-in-the-loop is just send(user, ...)
defineTrigger({ on, profile, filter?, prompt })  // dumb waker: signal → (filter) → spawn

// The product is one reviewable file
workflow.yml = trigger + inline agents + stages/loop + context + policy + secrets
```

Triggers reduce cron, GitHub webhooks, and Sentry alerts to one operation: *wake a workflow's session with context.* They never contain agent logic — coordination lives in the workflow's declarative loop or its `run:` code module, and judgment lives in the agents.

---

## Design principles

1. **The session is the thing that must survive.** Everything else is cattle.
2. **Decouple the brain from the hands.** The harness never lives in the sandbox. You cannot retrofit this — safety, replaceability, and observability all depend on the boundary.
3. **Multiplayer by construction.** A private agent's ceiling is the one person at the keyboard. A live, shared log compounds with every session.
4. **The next agent is a workflow file, not a platform.**
5. **Statelessness is a contract, not a vibe.** Replay reads recorded results. The harness is a projection of the log.

---

## Shape of the repo

```
oma/
├─ packages/
│  ├─ core/                  # contracts, event schemas, runtime invariants — deps: zod. nothing else.
│  ├─ workflows/             # workflow.yml: trigger + inline agents + stages + policy over the substrate
│  ├─ adapters/
│  │  ├─ session-memory      │ session-sqlite │ session-postgres            # SessionStore + run claims
│  │  ├─ sandbox-local       │ sandbox-worktree │ sandbox-docker            # Sandbox
│  │  ├─ model-fake          │ model-openai-compatible │ model-anthropic    # ModelProvider
│  │  ├─ tools-local         │ tools-github │ tools-github-simulated │ tools-mcp
│  │  └─ trigger-github      │ trigger-http │ trigger-sentry
│  └─ cli/                   # one surface over the primitives
├─ templates/                # installable products: pr-review, issue-to-pr, incident-to-pr, nightly-triage
├─ skills/oma/               # the skill that teaches coding agents to drive all of this
└─ examples/                 # deterministic, offline substrate + workflow demos
```

Planned adapters follow the same shape without touching core: an Electric session store (live `subscribe`/`fork` from Durable Streams), Modal and Cloudflare Containers sandboxes, and Slack/Linear trigger sources.

The dependency direction is part of the design: **adapters depend on core; core depends on nothing** — no model SDK, no database driver, no sandbox provider, no agent framework. Bring your own model, store, sandbox, and cloud. Every session store implements `subscribe` and `fork` against the same interface and passes the same contract suite.

---

## Install

OMA runs on [Bun](https://bun.sh) (it uses Bun's SQLite, YAML, and process
APIs directly — Node alone is not enough):

```bash
curl -fsSL https://bun.sh/install | bash
```

Install the CLI package:

```bash
bun add -g oma-run
```

Or install from a checkout for local development:

```bash
git clone https://github.com/mitchforest/oma && cd oma
bun install
cd packages/cli && bun link        # global `oma` command
```

No API keys are required to start: the default model is an offline fake, and
`model: claude-code:opus` / `model: codex:gpt-5.5#medium` ride the Claude
Code / Codex CLIs you are already logged into.

## Status & getting started

OMA is early and built in the open. The local runtime is usable today:

```bash
oma init
oma run examples/issue-to-pr-demo/workflow.yml --input issue=412
oma list
oma show <sessionId>
oma approve <sessionId>
oma tail <sessionId>
oma fork <sessionId> <offset>
oma ui --port 8788
```

### Ten minutes to an automation

```bash
oma templates                    # pr-review, issue-to-pr, incident-to-pr, nightly-triage
oma init --template pr-review    # installs + validates the workflow, prints next steps
oma skill install                # teach Claude Code (etc.) to drive OMA
```

Then tell your coding agent "use oma to set up a bugbot" — it scaffolds,
authors, validates, and hands you the watch/approve commands.

### Workflows

A workflow is one YAML file binding a trigger, inline agents, a prompt, and
policy — the file is the whole product. With a trigger it is an automation;
the same file runs manually. The canonical example is a PR review bot with
one durable session per pull request (`templates/pr-review/`):

```yaml
name: pr-review
trigger:
  on: github:pull_request.opened
  also: [github:pull_request.synchronize]
  filter: { payload.draft: false }
  session: "review:{payload.repo}#{payload.pr}"
agent:
  prompt: You review pull requests. Comment only on concrete, actionable issues.
  tools: [get_diff, get_prior_comments, post_inline_comment, post_review, read_file]
prompt: |
  Review pull request {payload.pr} in {payload.repo}.
policy:
  maxSteps: 32
  effects: { post_review: allow, post_inline_comment: { max: 20 }, "*": deny }
```

```bash
oma workflow validate .oma/workflows/pr-review.yml
oma workflow list
oma run pr-review                      # manual run by name
GITHUB_WEBHOOK_SECRET=... oma serve webhooks
```

Every load and run is recorded in the session log (`workflow.loaded`,
`workflow.run.started`) with the sha256 of the source file, so the trace states
exactly which version of the workflow handled each signal. See
`packages/workflows/README.md` and `templates/pr-review/README.md`.

The default model is fake so the durable runtime can be tested without network or API keys. To use an OpenAI-compatible provider, edit `.oma/config.json`:

```json
{
  "store": {
    "kind": "sqlite",
    "path": ".oma/sessions.sqlite"
  },
  "model": {
    "kind": "openai-compatible",
    "model": "gpt-4.1-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "sandbox": {
    "kind": "local",
    "cwd": "."
  }
}
```

Anthropic is also supported:

```json
{
  "model": {
    "kind": "anthropic",
    "model": "claude-sonnet-4-5",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

Stores are selected in `.oma/config.json`:

```json
{ "store": { "kind": "memory" } }
{ "store": { "kind": "sqlite", "path": ".oma/sessions.sqlite" } }
{ "store": { "kind": "postgres", "connectionStringEnv": "DATABASE_URL" } }
```

SQLite is the default local durable store. Memory is useful for fixtures and tests. Postgres is the durable multi-process store; `subscribe` works across store instances by reading the event log from the requested offset.

Sandboxes are selected in `.oma/config.json` too. Local is the default; worktree isolates file mutations from your working tree; Docker runs commands in a container. Command execution does not inherit `process.env` by default; only `PATH` plus explicit `sandbox.env` or tool env is passed. For profile runs, `.oma/config.json` is only the default: `profile.sandboxPolicy` is merged over it and governs the session's command allowlists, cwd, env, timeouts, output caps, and sandbox kind.

```json
{ "sandbox": { "kind": "local", "cwd": ".", "allowedCommands": ["bun", "git", "rg"] } }
{ "sandbox": { "kind": "worktree", "repo": ".", "baseRef": "HEAD", "allowedCommands": ["bun", "git", "rg"] } }
{ "sandbox": { "kind": "docker", "image": "oven/bun:1", "mount": ".", "network": "disabled", "allowedCommands": ["bun"] } }
```

Sandbox diagnostics are available without starting a session:

```bash
oma sandbox inspect --json
oma sandbox check
```

MCP stdio servers can be imported as namespaced OMA tools:

```json
{
  "tools": {
    "mcp": {
      "servers": [
        {
          "name": "example",
          "command": "node",
          "args": ["server.js"]
        }
      ]
    }
  }
}
```

Useful CLI flags:

```bash
oma init --store postgres
oma store check --json
oma sandbox inspect --json
oma send --no-wake <sessionId> "append only"
oma show --events <sessionId>
oma show --tools <sessionId>
oma show --runs <sessionId>
oma tail --format timeline <sessionId>
```

`oma ui` is a local read model over the configured session store. It serves the same
projections used by `show`: transcript, timeline, tool calls, run lifecycle, raw
events, and forks. Browser wake and fork actions append to the same durable log as
the CLI.

Triggers are thin wakers. They normalize a signal, resolve the workflow's session
key, and route into an ordinary durable session — the first signal for a key spawns
it, later signals wake it with its history intact:

```bash
oma trigger emit pr-review github pull_request.opened --payload '{"repo":"owner/repo","pr":42,"draft":false}' --json
GITHUB_WEBHOOK_SECRET=... oma serve webhooks
```

Recurring work is cron invoking `oma run <name>` — there is no separate scheduler to
learn. Remote execution is `runs_on: worker:<name>` in a stage plus `oma worker
--name <name>` on the machine that should do it.

Models route per agent with one string: `model: codex:gpt-5.5#medium` or
`model: claude-code:opus` ride the coding-agent CLIs you are already logged
into — no API keys — while a plain name targets the provider configured in
`.oma/config.json`. Mixing them is the point: plan and judge with one brain,
execute with another.

Start with `examples/issue-to-pr-demo/` — every workflow in it runs offline on
deterministic models, so you can see the full trace anatomy before configuring a
real provider. Most people never touch the core.

---

## Security & trust

Read this before running unattended workflows.

- **The workflow file is the control surface.** Review `policy.effects`,
  `env.secrets`, and the agents' tools before serving or scheduling a file —
  that is the whole point of the format.
- **OMA's effects policy governs OMA tools only.** Stages on
  `claude-code:<model>` or `codex:<model>` delegate to an external harness
  that brings its own tools: Codex runs inside its own sandbox
  (`workspace-write` by default), while Claude Code runs headless with
  permission prompts bypassed — treat such stages like trusted code and run
  them in checkouts you would hand to an agent.
- **`module://` models and `run:` code workflows execute code you point them
  at.** Same trust level as installing a dependency.
- **Secrets are references** (`env://`, `file://`, `keychain://`) resolved
  harness-side; values never enter the session log, model context, or YAML.
  Only names listed under `env.expose` reach a sandbox's environment.
- **`oma serve` and `oma ui` are tunnel-grade.** Webhook deliveries are
  HMAC-verified (`--github-secret`, `--sentry-secret`), but there is no TLS
  or user auth — put them behind a tunnel (cloudflared/ngrok) or a private
  network, not on an open port.

## Known limitations

- Token counts in context packs are a chars/4 estimate, not a provider
  tokenizer; codemaps are a heuristic line scanner (top-level signatures and
  headings), not a parser.
- SQLite stores are single-machine; multi-machine workers need the Postgres
  store. Cross-machine placement is contract-tested but young.
- Workers discover work by polling `listSessions` — fine for tens of
  sessions, not thousands.
- `oma serve` reloads workflow files per delivery (by design — edits apply
  without restarts); heavy webhook volume has not been load-tested.

Stable enough to build against in the local alpha: `@oma/core` interfaces, profile JSON,
adapter contract tests, and the reference examples. Still experimental: CLI runtime
internals, UI internals, package publishing shape, and store schema migrations beyond
the current versions.

---

## Not in scope

OMA is deliberately not:

- **An integrations marketplace.** Tools and auth are MCP (and connectors like Composio). We don't ship 500 connectors; we make any of them pluggable.
- **A workflow engine.** Multi-step orchestration lives in the agent's reasoning or in an external engine you plug in — never smeared into triggers or the core.
- **A model.** Bring your own. Swap mid-session; the agent persists because the agent is the log, not the model.

---

*Built on the worldview of Anthropic's Managed Agents and Electric's "the agent is the log." Influenced by Shopify's Aquifer, Ramp's Inspect, WorkOS's Horizon, Stripe's Minions, and Block's Goose. Standing on pi's proof that a minimal, hackable harness can be a joy to use.*
