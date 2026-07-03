import {
  deriveSessionStatus,
  hasSessionProjections,
  send,
  sessionStoreCapabilities,
  type SessionEvent
} from "@oma/core";
import {
  manualTriggerSignal,
  requireLoadedWorkflow,
  resolveWorkflowInputs
} from "@oma/workflows";
import { keyValuePairs, numberFlag, parseArgs } from "../args";
import {
  formatTailEvent,
  printSendResult,
  printSession,
  printTriggerRouteOutput,
  printWorkflowResume,
  showPayload
} from "../print";
import {
  loadRuntime,
  loadStoreBundle,
  resolveWorkflowTarget,
  resumeSessionSmart,
  routeWorkflowSignal
} from "../runtime";

const runUsage = "Usage: oma run <workflow.yml|name> [--input key=value ...]";

export async function runCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["max-steps"], multi: ["input"] });
  const [target, ...extra] = parsed.positionals;

  if (!target) {
    throw new Error(runUsage);
  }

  if (extra.length > 0) {
    throw new Error(
      "Workflows define their own prompt; pass inputs with --input key=value instead of a message."
    );
  }

  const workflowPath = await resolveWorkflowTarget(target);

  if (!workflowPath) {
    throw new Error(`No workflow named "${target}" in .oma/workflows. ${runUsage}`);
  }

  const loaded = await requireLoadedWorkflow(workflowPath);
  const { inputs, errors } = resolveWorkflowInputs(
    loaded.workflow,
    keyValuePairs(parsed, "input")
  );

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const bundle = await loadRuntime();
  const output = await routeWorkflowSignal(
    bundle,
    workflowPath,
    manualTriggerSignal(loaded.workflow, inputs),
    {
      maxSteps: numberFlag(parsed, "max-steps", { integer: true, min: 1 }),
      preloaded: loaded
    }
  );

  printTriggerRouteOutput(output, parsed.flags.has("json"));
  return output.status === "failed" ? 1 : 0;
}

export async function wakeCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const [sessionId] = parsed.positionals;

  if (!sessionId) {
    throw new Error("Usage: oma wake <sessionId>");
  }

  // Every session resumes through its workflow file, so effects, budgets,
  // and secrets re-apply from the YAML on every wake; stage sessions resume
  // their parent's orchestration.
  const bundle = await loadRuntime();
  const { sessionId: resumedId, result } = await resumeSessionSmart(bundle, sessionId);

  printWorkflowResume(resumedId, result, parsed.flags.has("json"));
  return result.status === "failed" ? 1 : 0;
}

export async function sendCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json", "no-wake"] });
  const [sessionId, ...messageParts] = parsed.positionals;
  const message = messageParts.join(" ");

  if (!sessionId || !message) {
    throw new Error("Usage: oma send <sessionId> <message>");
  }

  const bundle = await loadRuntime();
  const session = await bundle.store.getSession(sessionId);

  // Chat only makes sense for single-stage workflow sessions. Staged parents
  // are orchestration logs; stage sessions are driven by the runner.
  if (session.metadata?.workflowKind === "staged") {
    throw new Error(
      `Session ${sessionId} is a staged workflow; it takes --input on run and oma approve/deny, not chat.`
    );
  }

  if (typeof session.metadata?.parentSessionId === "string") {
    throw new Error(
      `Session ${sessionId} is a workflow stage; the workflow drives its messages. Approve, deny, or edit the workflow instead.`
    );
  }

  if (typeof session.metadata?.workflowPath !== "string") {
    throw new Error(`Session ${sessionId} is not a workflow session.`);
  }

  await send(bundle.store, sessionId, message);

  if (parsed.flags.has("no-wake")) {
    const updated = await bundle.store.getSession(sessionId);
    printSendResult(
      {
        sessionId,
        status: deriveSessionStatus(updated.events),
        events: updated.events
      },
      parsed.flags.has("json")
    );
    return 0;
  }

  const { result } = await resumeSessionSmart(bundle, sessionId);

  printWorkflowResume(sessionId, result, parsed.flags.has("json"));
  return result.status === "failed" ? 1 : 0;
}

export async function showCommand(args: string[], eventsOnly: boolean): Promise<void> {
  const parsed = parseArgs(args, {
    flags: ["json", "events", "tools", "runs", "timeline", "forks"]
  });
  const sessionId = parsed.positionals[0];
  const json = parsed.flags.has("json");
  const events = eventsOnly || parsed.flags.has("events");

  if (!sessionId) {
    throw new Error("Usage: oma show <sessionId> [--json] [--events]");
  }

  const bundle = await loadStoreBundle();
  const session = await bundle.store.getSession(sessionId);
  const forks =
    parsed.flags.has("forks") && hasSessionProjections(bundle.store)
      ? await bundle.store.listForks(sessionId)
      : [];

  if (json) {
    console.log(JSON.stringify(showPayload(session, parsed, events, forks), null, 2));
    return;
  }

  printSession(session, {
    events,
    tools: parsed.flags.has("tools"),
    runs: parsed.flags.has("runs"),
    timeline: parsed.flags.has("timeline"),
    forks: parsed.flags.has("forks"),
    forkSummaries: forks
  });
}

export async function listCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const bundle = await loadStoreBundle();
  if (!hasSessionProjections(bundle.store)) {
    throw new Error("Configured store does not support session projections");
  }

  const sessions = await bundle.store.listSessions();

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log("no sessions");
    return;
  }

  for (const item of sessions) {
    const profile = String(item.metadata?.profilePath ?? "-");
    const preview = item.preview ?? "";

    console.log(
      `${item.id}  ${item.status.padEnd(9)}  ${String(item.eventCount).padStart(3)} events  ${profile}  ${preview}`
    );
  }
}

export async function forkCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const [sessionId, offsetText] = parsed.positionals;
  const offset = Number(offsetText);

  if (!sessionId || !Number.isInteger(offset)) {
    throw new Error("Usage: oma fork <sessionId> <offset>");
  }

  const bundle = await loadStoreBundle();
  const source = await bundle.store.getSession(sessionId);
  const forkId = await bundle.store.fork(sessionId, offset, {
    metadata: {
      ...source.metadata,
      forkedFrom: { sessionId, atOffset: offset }
    }
  });

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify({ sessionId, offset, forkId }, null, 2));
    return;
  }

  console.log(`forked ${sessionId}@${offset} -> ${forkId}`);
}

export async function tailCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["from-offset", "format"] });
  const [sessionId] = parsed.positionals;

  if (!sessionId) {
    throw new Error("Usage: oma tail <sessionId> [--json] [--from-offset <n>]");
  }

  const bundle = await loadStoreBundle();
  const fromOffset = numberFlag(parsed, "from-offset", { integer: true, min: 0 }) ?? 0;
  const format = parsed.values.get("format") ?? "events";
  const print = (event: SessionEvent) => {
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(event));
      return;
    }

    console.log(formatTailEvent(event, format));
  };

  if (!sessionStoreCapabilities(bundle.store).crossProcessSubscribe) {
    // subscribe() only sees appends from this process for these stores; tail
    // is its own process, so poll the durable log instead.
    console.error(
      "store does not deliver cross-process subscriptions; polling for new events"
    );
    let offset = fromOffset;

    for (;;) {
      const session = await bundle.store.getSession(sessionId, { fromOffset: offset });

      for (const event of session.events) {
        print(event);
        offset = event.offset + 1;
      }

      await Bun.sleep(500);
    }
  }

  for await (const event of bundle.store.subscribe(sessionId, { fromOffset })) {
    print(event);
  }
}
