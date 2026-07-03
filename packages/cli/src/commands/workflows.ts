import {
  buildContextPack,
  contextPackEvent,
  defaultWorkflowDir,
  deriveProgress,
  formatWorkflowDiagnostics,
  listWorkflowFiles,
  loadWorkflowDocument,
  manualTriggerPattern,
  type LoadedWorkflow,
  type WorkflowDiagnostic
} from "@oma/workflows";
import { findCallApprovalState, type SessionEvent } from "@oma/core";
import { parseArgs } from "../args";
import { printWorkflowResume } from "../print";
import {
  loadAuthoringRuntime,
  loadRuntime,
  missingAgentTools,
  resumeWorkflowSession,
  runtimeForAgent
} from "../runtime";

export async function workflowCommand(args: string[]): Promise<number | void> {
  const [subcommand, ...rest] = args;

  if (subcommand === "validate") {
    return workflowValidateCommand(rest);
  }

  if (subcommand === "inspect") {
    return workflowInspectCommand(rest);
  }

  if (subcommand === "list") {
    return workflowListCommand(rest);
  }

  if (subcommand === "context") {
    return workflowContextCommand(rest);
  }

  throw new Error("Usage: oma workflow <validate|inspect|list|context> ...");
}

/**
 * Builds and prints a workflow's context pack without touching a model or
 * store — the same selection and budget fitting a run would record.
 */
async function workflowContextCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["stage"] });
  const [workflowPath] = parsed.positionals;

  if (!workflowPath) {
    throw new Error("Usage: oma workflow context <workflowPath> [--stage <name>] [--json]");
  }

  const loaded = await loadWorkflowDocument(workflowPath, { compileAgents: false });
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

  if (!loaded.workflow || errors.length > 0) {
    throw new Error(formatWorkflowDiagnostics(loaded.diagnostics));
  }

  const stageName = parsed.values.get("stage");
  const block = stageName
    ? (loaded.workflow.stages?.[stageName]?.context ?? loaded.workflow.context)
    : loaded.workflow.context;

  if (stageName && !loaded.workflow.stages?.[stageName]) {
    throw new Error(`Workflow ${loaded.workflow.name} has no stage "${stageName}".`);
  }

  if (!block) {
    throw new Error(
      `Workflow ${loaded.workflow.name}${stageName ? ` stage "${stageName}"` : ""} declares no context block.`
    );
  }

  const pack = await buildContextPack(block);

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(contextPackEvent(pack), null, 2));
    return 0;
  }

  console.log(`pack     ${pack.packId}`);
  console.log(
    `tokens   ${pack.totalTokens}${pack.budget !== undefined ? ` of ${pack.budget} budget` : " (no budget)"} — chars/4 estimate`
  );

  for (const file of pack.files) {
    const notes = [file.mode, file.demoted ? "demoted" : undefined].filter(Boolean).join(", ");
    console.log(`  ${file.path.padEnd(48)} ${String(file.tokens).padStart(7)}  ${notes}`);
  }

  for (const drop of pack.dropped) {
    console.log(`  ${drop.path.padEnd(48)} ${String(drop.tokens).padStart(7)}  dropped: ${drop.reason}`);
  }

  return 0;
}

async function workflowValidateCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const [workflowPath] = parsed.positionals;

  if (!workflowPath) {
    throw new Error("Usage: oma workflow validate <workflowPath> [--json]");
  }

  const loaded = await loadWorkflowDocument(workflowPath);
  const diagnostics = [...loaded.diagnostics, ...(await agentToolDiagnostics(loaded))];
  const failed = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  if (parsed.flags.has("json")) {
    console.log(
      JSON.stringify(
        {
          workflow: loaded.workflow,
          path: loaded.path,
          sourceHash: loaded.sourceHash,
          diagnostics
        },
        null,
        2
      )
    );
  } else if (diagnostics.length === 0) {
    console.log(`valid ${loaded.workflow?.name ?? workflowPath}`);
  } else {
    console.log(formatWorkflowDiagnostics(diagnostics));
  }

  return failed ? 1 : 0;
}

async function workflowInspectCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const [workflowPath] = parsed.positionals;

  if (!workflowPath) {
    throw new Error("Usage: oma workflow inspect <workflowPath> [--json]");
  }

  const loaded = await loadWorkflowDocument(workflowPath);
  const errors = loaded.diagnostics.filter((diagnostic) => diagnostic.severity === "error");

  if (!loaded.workflow || errors.length > 0) {
    throw new Error(formatWorkflowDiagnostics(loaded.diagnostics));
  }

  const workflow = loaded.workflow;
  const inspection = {
    name: workflow.name,
    title: workflow.title,
    description: workflow.description,
    path: loaded.path,
    sourceHash: loaded.sourceHash,
    triggers: [
      ...(workflow.trigger ? [workflow.trigger.on, ...workflow.trigger.also] : []),
      manualTriggerPattern
    ],
    filter: workflow.trigger?.filter,
    session: workflow.trigger?.session,
    agent: workflow.agent
      ? {
          prompt: snippet(workflow.agent.prompt),
          tools: workflow.agent.tools,
          sandbox: workflow.agent.sandbox,
          model: workflow.agent.model ?? "(runtime default)"
        }
      : undefined,
    prompt: workflow.prompt,
    stages: workflow.stages
      ? Object.entries(workflow.stages).map(([stageName, stage]) => {
          const agent = stage.agent ?? workflow.agent;
          return {
            name: stageName,
            agent: agent ? snippet(agent.prompt) : undefined,
            tools: agent?.tools ?? [],
            model: agent?.model ?? "(runtime default)",
            runsOn: stage.runs_on,
            approve: stage.approve,
            output: stage.output ? Object.keys(stage.output) : undefined
          };
        })
      : undefined,
    loop: workflow.loop,
    inputs: workflow.inputs,
    policy: workflow.policy
  };

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  console.log(`workflow ${inspection.name}${inspection.title ? `  (${inspection.title})` : ""}`);
  console.log(`source   ${inspection.path}`);
  console.log(`hash     ${inspection.sourceHash}`);
  console.log(`triggers ${inspection.triggers.join(", ")}`);

  if (inspection.session) {
    console.log(`session  ${inspection.session}`);
  }

  if (inspection.agent) {
    console.log(`agent    "${inspection.agent.prompt}"`);
    console.log(`tools    ${inspection.agent.tools.join(", ") || "(none)"}`);
    console.log(`model    ${inspection.agent.model}`);
  }

  for (const stage of inspection.stages ?? []) {
    const details = [
      `model=${stage.model}`,
      stage.runsOn ? `runs_on=${stage.runsOn}` : undefined,
      stage.approve ? "approve" : undefined,
      stage.output ? `output={${stage.output.join(", ")}}` : undefined
    ]
      .filter(Boolean)
      .join(" ");

    console.log(`stage    ${stage.name}  ${details}`);
  }

  if (inspection.loop) {
    console.log(
      `loop     over [${inspection.loop.over.join(", ")}] until ${inspection.loop.until} (max ${inspection.loop.max})`
    );
  }

  const inputNames = Object.keys(workflow.inputs);

  if (inputNames.length > 0) {
    console.log(`inputs   ${inputNames.join(", ")}`);
  }
}

async function workflowListCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["dir"] });
  const dir = parsed.values.get("dir") ?? defaultWorkflowDir;
  const files = await listWorkflowFiles(dir);
  const rows = [];

  for (const file of files) {
    const loaded = await loadWorkflowDocument(file, { compileAgents: false });
    rows.push({
      name: loaded.workflow?.name ?? "(invalid)",
      file,
      on: loaded.workflow?.trigger?.on ?? "manual",
      session: loaded.workflow?.trigger?.session,
      valid: !loaded.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    });
  }

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`no workflows in ${dir}`);
    return;
  }

  for (const row of rows) {
    const marker = row.valid ? " " : "!";
    console.log(`${marker} ${row.name.padEnd(24)} ${row.on.padEnd(32)} ${row.file}`);
  }
}

export async function approvalCommand(
  args: string[],
  decision: "granted" | "denied"
): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: ["note", "reason"] });
  const [sessionId] = parsed.positionals;

  if (!sessionId) {
    throw new Error(
      decision === "granted"
        ? "Usage: oma approve <sessionId> [--note <text>]"
        : "Usage: oma deny <sessionId> [--reason <text>]"
    );
  }

  const bundle = await loadRuntime();
  const session = await bundle.store.getSession(sessionId);

  // Approve-gated tool calls take precedence: they live in the session where
  // the call was recorded (a stage session, or a single-stage workflow session).
  const pendingCall = findPendingToolApproval(session.events);

  if (pendingCall) {
    await bundle.store.appendEvent(
      sessionId,
      decision === "granted"
        ? {
            type: "human.approval.granted",
            callId: pendingCall.callId,
            toolName: pendingCall.toolName,
            note: parsed.values.get("note")
          }
        : {
            type: "human.approval.denied",
            callId: pendingCall.callId,
            toolName: pendingCall.toolName,
            reason: parsed.values.get("reason")
          }
    );

    // Resume the workflow that owns this call: the parent for stage sessions,
    // the session itself otherwise.
    const parentId =
      typeof session.metadata?.parentSessionId === "string"
        ? session.metadata.parentSessionId
        : undefined;
    const target =
      typeof session.metadata?.workflowPath === "string" ? sessionId : (parentId ?? sessionId);
    const { result } = await resumeWorkflowSession(bundle, target);

    printWorkflowResume(target, result, parsed.flags.has("json"));
    return result.status === "failed" ? 1 : 0;
  }

  const progress = deriveProgress(session.events);
  const awaiting = [...progress.requested]
    .filter((key) => !progress.granted.has(key) && !progress.denied.has(key))
    .at(-1);

  if (!awaiting) {
    throw new Error(`Session ${sessionId} has no approval awaiting a decision.`);
  }

  const [stage, iterationText] = splitStageKey(awaiting);
  const iteration = Number(iterationText);

  await bundle.store.appendEvent(
    sessionId,
    decision === "granted"
      ? {
          type: "human.approval.granted",
          stage,
          iteration,
          note: parsed.values.get("note")
        }
      : {
          type: "human.approval.denied",
          stage,
          iteration,
          reason: parsed.values.get("reason")
        }
  );

  const { result } = await resumeWorkflowSession(bundle, sessionId);

  printWorkflowResume(sessionId, result, parsed.flags.has("json"));
  return result.status === "failed" ? 1 : 0;
}

function findPendingToolApproval(
  events: SessionEvent[]
): { callId: string; toolName?: string } | undefined {
  let pending: { callId: string; toolName?: string } | undefined;

  for (const event of events) {
    if (event.type === "human.approval.requested" && event.callId) {
      if (findCallApprovalState(events, event.callId) === "requested") {
        pending = { callId: event.callId, toolName: event.toolName };
      }
    }
  }

  return pending;
}

function splitStageKey(key: string): [string, string] {
  const separator = key.lastIndexOf("#");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function snippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
}

/**
 * Tool-level validation needs a runtime (tools are live objects); the
 * authoring runtime never touches the durable store, MCP, or credentials.
 */
async function agentToolDiagnostics(loaded: LoadedWorkflow): Promise<WorkflowDiagnostic[]> {
  if (!loaded.agents) {
    return [];
  }

  const bundle = await loadAuthoringRuntime();
  const diagnostics: WorkflowDiagnostic[] = [];
  const entries: Array<[string, (typeof loaded.agents)["default"]]> = [
    ["agent", loaded.agents.default],
    ...Object.entries(loaded.agents.stages).map(
      ([stage, agent]): [string, (typeof loaded.agents)["default"]] => [
        `stages.${stage}.agent`,
        agent
      ]
    )
  ];
  const seen = new Set<string>();

  for (const [path, agent] of entries) {
    if (!agent || seen.has(agent.profile.name)) {
      continue;
    }

    seen.add(agent.profile.name);

    const { runtime } = await runtimeForAgent(bundle, agent, {
      allowMissingCredentials: true
    });

    for (const missing of missingAgentTools(agent.profile, runtime.tools)) {
      diagnostics.push({
        severity: "error",
        code: "workflow.tool_missing",
        message: `Tool "${missing}" is not available in this runtime.`,
        path: `${path}.tools`,
        hint: "Remove it or configure the adapter that provides it."
      });
    }
  }

  return diagnostics;
}
