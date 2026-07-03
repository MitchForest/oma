import {
  deriveRuns,
  deriveSessionStatus,
  deriveSessionView,
  deriveTimeline,
  deriveToolCalls,
  deriveTranscript,
  type ForkSummary,
  type SandboxPolicy,
  type SessionEvent,
  type SessionRecord
} from "@oma/core";
import type { ParsedArgs } from "./args";
import type { TriggerRouteOutput } from "./runtime";

export function printSendResult(
  value: { sessionId: string; status: string; events: SessionEvent[] },
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(`session ${value.sessionId}`);
  console.log(`status  ${value.status}`);
}

export function printSandboxInspection(
  value: {
    policy: SandboxPolicy;
    sandboxId?: string;
    check?: {
      command: string;
      exitCode: number | null;
      timedOut: boolean;
      truncated: boolean;
      stdout: string;
      stderr: string;
    };
  },
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(`sandbox ${value.policy.kind}`);
  console.log(`cwd     ${String(value.policy.cwd ?? "-")}`);

  if (value.policy.allowedCommands) {
    console.log(`allow   ${value.policy.allowedCommands.join(", ")}`);
  }

  if (value.sandboxId) {
    console.log(`id      ${value.sandboxId}`);
  }

  if (value.check) {
    const suffix = value.check.timedOut ? " (timed out)" : "";
    console.log(`check   ${value.check.command} -> exit ${value.check.exitCode}${suffix}`);
  }
}

export function printTriggerRouteOutput(
  output: TriggerRouteOutput & {
    awaiting?: { stage: string; iteration: number };
    reason?: string;
  },
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`result  ${output.route.type}`);

  if ("sessionId" in output.route) {
    console.log(`session ${output.route.sessionId}`);
  }

  if (output.status) {
    console.log(`status  ${output.status}`);
  }

  // A pause with a reason (dispatch, budget, tool approval) explains itself;
  // a bare awaiting pause is a stage gate needing a decision.
  if (output.reason) {
    console.log(`reason  ${output.reason}`);
  } else if (output.awaiting && "sessionId" in output.route) {
    console.log(
      `await   stage "${output.awaiting.stage}" (iteration ${output.awaiting.iteration}) — decide with: oma approve ${output.route.sessionId} | oma deny ${output.route.sessionId}`
    );
  }
}

export function printWorkflowResume(
  sessionId: string,
  result: { status: string; reason?: string; awaiting?: { stage: string; iteration: number } },
  json: boolean
): void {
  if (json) {
    console.log(JSON.stringify({ sessionId, ...result }, null, 2));
    return;
  }

  console.log(`session ${sessionId}`);
  console.log(`status  ${result.status}`);

  if (result.reason) {
    console.log(`reason  ${result.reason}`);
  }

  if (result.awaiting) {
    console.log(
      `await   stage "${result.awaiting.stage}" (iteration ${result.awaiting.iteration}) — decide with: oma approve ${sessionId} | oma deny ${sessionId}`
    );
  }
}

export function showPayload(
  session: SessionRecord,
  parsed: ParsedArgs,
  eventsOnly: boolean,
  forks: ForkSummary[]
): unknown {
  if (eventsOnly) {
    return session.events;
  }

  if (parsed.flags.has("tools")) {
    return deriveToolCalls(session.events);
  }

  if (parsed.flags.has("runs")) {
    return deriveRuns(session.events);
  }

  if (parsed.flags.has("timeline")) {
    return deriveTimeline(session.events);
  }

  if (parsed.flags.has("forks")) {
    return {
      forkedFrom: session.events.filter((event) => event.type === "session.forked"),
      forks
    };
  }

  return {
    ...session,
    view: deriveSessionView(session.events)
  };
}

export function printSession(
  session: SessionRecord,
  options: {
    events: boolean;
    tools?: boolean;
    runs?: boolean;
    timeline?: boolean;
    forks?: boolean;
    forkSummaries?: ForkSummary[];
  }
): void {
  console.log(`session ${session.id}`);
  console.log(`status  ${deriveSessionStatus(session.events)}`);

  if (options.tools) {
    printTools(session.events);
    return;
  }

  if (options.runs) {
    printRuns(session.events);
    return;
  }

  if (options.timeline) {
    printTimeline(session.events);
    return;
  }

  if (options.forks) {
    printForks(session.events, options.forkSummaries ?? []);
    return;
  }

  if (session.events.length === 0) {
    console.log("events  none");
    return;
  }

  if (options.events) {
    for (const event of session.events) {
      console.log(`${String(event.offset).padStart(4)} ${event.type} ${JSON.stringify(event)}`);
    }

    return;
  }

  printTranscript(session.events);
}

function printTranscript(events: SessionEvent[]): void {
  for (const item of deriveTranscript(events)) {
    console.log(`${String(item.offset).padStart(4)} ${item.role.padEnd(9)} ${oneLine(item.content)}`);
  }
}

function printTools(events: SessionEvent[]): void {
  const tools = deriveToolCalls(events);

  if (tools.length === 0) {
    console.log("tools   none");
    return;
  }

  for (const tool of tools) {
    const status = tool.status.padEnd(9);
    const result = tool.status === "failed"
      ? oneLine(JSON.stringify(tool.error))
      : tool.status === "completed"
        ? oneLine(JSON.stringify(tool.result))
        : oneLine(JSON.stringify(tool.args));

    console.log(`${String(tool.offset).padStart(4)} ${status} ${tool.toolName} ${result}`);
  }
}

function printRuns(events: SessionEvent[]): void {
  const runs = deriveRuns(events);

  if (runs.length === 0) {
    console.log("runs    none");
    return;
  }

  for (const run of runs) {
    const detail = run.error
      ? oneLine(JSON.stringify(run.error))
      : run.reason
        ? run.reason
        : `${run.steps ?? 0} steps`;

    console.log(`${run.status.padEnd(9)} ${run.runId} ${detail}`);
  }
}

function printTimeline(events: SessionEvent[]): void {
  for (const item of deriveTimeline(events)) {
    const marker = item.severity === "error" ? "!" : item.severity === "warning" ? "*" : "-";
    console.log(`${String(item.offset).padStart(4)} ${marker} ${item.type.padEnd(24)} ${item.label}`);
  }
}

function printForks(events: SessionEvent[], forks: ForkSummary[]): void {
  const forkedFrom = events.filter((event) => event.type === "session.forked");

  if (forkedFrom.length === 0 && forks.length === 0) {
    console.log("forks   none");
    return;
  }

  for (const fork of forkedFrom) {
    console.log(`${String(fork.offset).padStart(4)} from ${fork.fromSessionId}@${fork.atOffset}`);
  }

  for (const fork of forks) {
    console.log(`child    ${fork.sessionId} from ${fork.forkedFromSessionId}@${fork.atOffset}`);
  }
}

export function formatTailEvent(event: SessionEvent, format: string): string {
  if (format === "transcript") {
    const [item] = deriveTranscript([event]);
    return item
      ? `${String(item.offset).padStart(4)} ${item.role.padEnd(9)} ${oneLine(item.content)}`
      : `${String(event.offset).padStart(4)} ${event.type}`;
  }

  if (format === "timeline") {
    const [item] = deriveTimeline([event]);
    const marker = item?.severity === "error" ? "!" : item?.severity === "warning" ? "*" : "-";
    return item
      ? `${String(item.offset).padStart(4)} ${marker} ${item.type.padEnd(24)} ${item.label}`
      : `${String(event.offset).padStart(4)} ${event.type}`;
  }

  return `${String(event.offset).padStart(4)} ${event.type} ${oneLine(JSON.stringify(event))}`;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 120);
}

export function printHelp(): void {
  console.log(`oma

The workflow file is the product: one YAML binding trigger, agents, policy,
and context over a durable, replayable session log.

Start:
  init [--store memory|sqlite|postgres] [--template <name>]
                                    Create .oma/ (--template installs a
                                    ready workflow: oma templates lists them)
  templates                         List installable templates
  skill install [--to <dir>]        Teach your coding agent to drive OMA
                                    (default .claude/skills)

Author:
  workflow validate <workflowPath>  Validate a workflow file
  workflow inspect <workflowPath>   Inspect triggers, agents, stages, policy
  workflow list [--dir <path>]      List workflows (default .oma/workflows)
  workflow context <workflowPath> [--stage <n>]
                                    Preview the context pack (files, modes,
                                    token estimates, budget fit)

Run:
  run <workflow.yml|name> [--input k=v ...]
                                    Run a workflow (bare names resolve in
                                    .oma/workflows/)
  trigger emit <workflow.yml|name> <source> <kind> --payload <json|@file>
                                    Emit a trigger signal (--no-wake for
                                    routing-only dry runs)
  serve webhooks [workflow.yml|dir] Serve every workflow's triggers (GitHub/
                                    Sentry deliveries verified via secrets)
  worker [--name <n>] [--once]      Claim and resume sessions whose stages
                                    run on worker:<n> (durable leases)

Operate:
  list                              List sessions with statuses
  show <sessionId> [--json|--events] Show a session's durable trace
  events <sessionId>                Show raw event lines
  tail <sessionId>                  Follow session events live
  wake <sessionId>                  Resume (re-reads the workflow YAML)
  send <sessionId> <message>        Chat with a single-stage workflow session
  approve <sessionId> [--note <t>]  Grant a pending approval (stage or tool)
  deny <sessionId> [--reason <t>]   Deny a pending approval
  fork <sessionId> <offset>         Branch a session at an offset
  ui [--port <n>]                   Local session UI

Inspect setup:
  config                            Print resolved runtime config
  store capabilities|check          Store introspection
  sandbox inspect|check             Sandbox introspection

Flags:
  --json                            Print JSON for scriptable commands
  --max-steps <n>                   Bound run/wake steps
  --input <key=value>               workflow run input (repeatable)
  --github-secret / --sentry-secret serve: webhook HMAC secrets
  --format events|timeline|transcript
                                    tail output format
  --no-wake                         send only: append without waking
`);
}
