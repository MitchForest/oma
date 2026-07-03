import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { LocalSandboxProvider } from "@oma/adapter-sandbox-local";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { createLocalTools } from "@oma/adapter-tools-local";
import { createMcpToolBundle } from "@oma/adapter-tools-mcp";
import { githubSignature, normalizeGitHubWebhook } from "@oma/adapter-trigger-github";
import { runPrReviewSimulation } from "@oma/example-pr-review-simulated";
import {
  MemoryWakeLock,
  defineProfile,
  defineTool,
  routeTriggerSignal,
  spawn,
  wake,
  type AnyTool,
  type Sandbox,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProvisionContext,
  type SessionEvent,
  type SessionStore,
  type Profile
} from "@oma/core";
import {
  createPrReviewModelProvider,
  createPrReviewTools,
  hydrateCommentsFromLog,
  type SimulatedComment
} from "@oma/example-pr-review-simulated";

export type ExampleName =
  | "minimal-replay"
  | "pr-review-simulated"
  | "local-coding-agent"
  | "background-job"
  | "forked-approaches"
  | "multiplayer-viewer"
  | "mcp-import"
  | "github-pr-review-webhook";

export interface ExampleSummary {
  name: ExampleName;
  claim: string;
  command: string;
  requiresNetwork: boolean;
}

export interface ExampleResult {
  example: ExampleName;
  claim: string;
  status: "passed";
  [key: string]: unknown;
}

export interface RunExampleOptions {
  store?: SessionStore;
}

export const referenceExamples: ExampleSummary[] = [
  {
    name: "minimal-replay",
    claim: "recorded tool results are not re-executed",
    command: "bun test examples/reference  # minimal-replay",
    requiresNetwork: false
  },
  {
    name: "pr-review-simulated",
    claim: "one PR maps to one durable idempotent review session",
    command: "bun test examples/reference  # pr-review-simulated",
    requiresNetwork: false
  },
  {
    name: "local-coding-agent",
    claim: "a local coding agent is a profile plus tools, sandbox, and session log",
    command: "bun test examples/reference  # local-coding-agent",
    requiresNetwork: false
  },
  {
    name: "background-job",
    claim: "a headless job uses the same durable agent substrate",
    command: "bun test examples/reference  # background-job",
    requiresNetwork: false
  },
  {
    name: "forked-approaches",
    claim: "forks share history and then diverge independently",
    command: "bun test examples/reference  # forked-approaches",
    requiresNetwork: false
  },
  {
    name: "multiplayer-viewer",
    claim: "multiple subscribers observe the same live session in order",
    command: "bun test examples/reference  # multiplayer-viewer",
    requiresNetwork: false
  },
  {
    name: "mcp-import",
    claim: "MCP stdio servers can become OMA tools without changing core",
    command: "bun test examples/reference  # mcp-import",
    requiresNetwork: false
  },
  {
    name: "github-pr-review-webhook",
    claim: "GitHub webhooks are thin trigger signals for PR review profiles",
    command: "bun test examples/reference  # github-pr-review-webhook",
    requiresNetwork: false
  }
];

export async function runReferenceExample(
  name: ExampleName,
  options: RunExampleOptions = {}
): Promise<ExampleResult> {
  if (name === "minimal-replay") {
    return runMinimalReplayExample();
  }

  if (name === "pr-review-simulated") {
    return runSimulatedPrReviewExample(options);
  }

  if (name === "local-coding-agent") {
    return runLocalCodingAgentExample();
  }

  if (name === "background-job") {
    return runBackgroundJobExample();
  }

  if (name === "forked-approaches") {
    return runForkedApproachesExample();
  }

  if (name === "multiplayer-viewer") {
    return runMultiplayerViewerExample();
  }

  if (name === "mcp-import") {
    return runMcpImportExample();
  }

  if (name === "github-pr-review-webhook") {
    return runGitHubPrReviewWebhookExample();
  }

  throw new Error(`Unknown reference example: ${name}`);
}

export function isReferenceExampleName(value: string): value is ExampleName {
  return referenceExamples.some((example) => example.name === value);
}

async function runMinimalReplayExample(): Promise<ExampleResult> {
  let toolExecutions = 0;
  const store = new MemorySessionStore();
  const profile = defineProfile({
    name: "minimal-replay",
    mode: "job",
    systemPrompt: "Prove replay.",
    skills: [],
    tools: ["count"],
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: {}
  });
  const tools = [
    defineTool({
      name: "count",
      handler: async () => {
        toolExecutions += 1;
        return { toolExecutions };
      }
    })
  ];
  const model = new FakeModelProvider([
    { toolCalls: [{ name: "count", args: {} }] },
    { finishReason: "done" }
  ]);
  const sessionId = await spawn(store, profile, { initialMessage: "run once" });
  await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
  const result = await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });

  return {
    example: "minimal-replay",
    claim: claimFor("minimal-replay"),
    status: "passed",
    sessionId,
    wakeStatus: result.status,
    toolExecutions,
    toolResultEvents: result.events.filter((event) => event.type === "tool.result").length,
    eventTypes: result.events.map((event) => event.type)
  };
}

async function runSimulatedPrReviewExample(options: RunExampleOptions): Promise<ExampleResult> {
  const store = options.store ?? new MemorySessionStore();
  const result = await runPrReviewSimulation({ store });
  const session = await store.getSession(result.sessionId);
  const triggerEvents = session.events.filter((event) => event.type === "trigger.received");
  const keys = result.comments.map((comment) => comment.key);

  return {
    example: "pr-review-simulated",
    claim: claimFor("pr-review-simulated"),
    status: "passed",
    sessionId: result.sessionId,
    wakeCount: triggerEvents.length,
    comments: result.comments,
    duplicateComments: keys.length - new Set(keys).size,
    forkId: result.forkId,
    reviewStatus: sessionStatus(session.events)
  };
}

async function runLocalCodingAgentExample(): Promise<ExampleResult> {
  const cwd = await makeExampleProject("local-coding-agent");
  const store = new MemorySessionStore();
  const profile = coderProfile("coder-interactive", "interactive");
  const sandboxProvider = new EventRecordingSandboxProvider(store);
  const tools = createLocalTools({
    cwd,
    allowedCommands: ["printf"],
    sandboxProvider,
    sandboxPolicy: { kind: "local", cwd, allowedCommands: ["printf"], timeoutMs: 10_000 }
  });
  const sessionId = await spawn(store, profile, {
    initialMessage: "Inspect this small project.",
    metadata: { example: "local-coding-agent" }
  });
  const result = await wake(
    {
      store,
      tools,
      model: new FakeModelProvider([
        { toolCalls: [{ name: "list_files", args: { maxResults: 20 } }] },
        { toolCalls: [{ name: "bash", args: { command: "printf", args: ["sandbox-ok"] } }] },
        { content: "The project contains a README and source file." },
        { finishReason: "done" }
      ]),
      wakeLock: new MemoryWakeLock()
    },
    sessionId,
    profile,
    { maxSteps: 4 }
  );

  return {
    example: "local-coding-agent",
    claim: claimFor("local-coding-agent"),
    status: "passed",
    sessionId,
    wakeStatus: result.status,
    toolCalls: toolCalls(result.events),
    sandboxEvents: result.events.filter((event) => event.type.startsWith("sandbox.")).map((event) => event.type)
  };
}

async function runBackgroundJobExample(): Promise<ExampleResult> {
  const cwd = await makeExampleProject("background-job");
  const store = new MemorySessionStore();
  const profile = coderProfile("coder-job", "job");
  const tools = createLocalTools({
    cwd,
    allowedCommands: ["rg"],
    sandboxProvider: new EventRecordingSandboxProvider(store),
    sandboxPolicy: { kind: "local", cwd, allowedCommands: ["rg"], timeoutMs: 10_000 }
  });
  const sessionId = await spawn(store, profile, {
    initialMessage: "Run a short headless inspection.",
    metadata: { example: "background-job" }
  });
  const result = await wake(
    {
      store,
      tools,
      model: new FakeModelProvider([
        { toolCalls: [{ name: "list_files", args: { maxResults: 20 } }] },
        { content: "Completed the headless inspection." },
        { finishReason: "done" }
      ]),
      wakeLock: new MemoryWakeLock()
    },
    sessionId,
    profile,
    { maxSteps: 4 }
  );

  return {
    example: "background-job",
    claim: claimFor("background-job"),
    status: "passed",
    sessionId,
    wakeStatus: result.status,
    runEvents: result.events.filter((event) => event.type.startsWith("run.")).map((event) => event.type),
    toolCalls: toolCalls(result.events)
  };
}

async function runForkedApproachesExample(): Promise<ExampleResult> {
  const store = new MemorySessionStore();
  const profile = defineProfile({
    name: "forked-approaches",
    mode: "interactive",
    systemPrompt: "Explore approaches.",
    skills: [],
    tools: [],
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: {}
  });
  const sourceSessionId = await spawn(store, profile, { initialMessage: "Find an approach." });
  await wake(
    {
      store,
      tools: [],
      model: new FakeModelProvider([{ content: "Shared starting analysis." }])
    },
    sourceSessionId,
    profile,
    { maxSteps: 1 }
  );
  const source = await store.getSession(sourceSessionId);
  const forkOffset = source.events.at(-1)?.offset ?? 0;
  const firstForkId = await store.fork(sourceSessionId, forkOffset);
  const secondForkId = await store.fork(sourceSessionId, forkOffset);
  await store.appendEvent(firstForkId, { type: "message.user", content: "Try approach A." });
  await store.appendEvent(secondForkId, { type: "message.user", content: "Try approach B." });
  const first = await wake(
    {
      store,
      tools: [],
      model: new FakeModelProvider([
        { content: "already recorded before fork" },
        { content: "Approach A completed." },
        { finishReason: "done" }
      ])
    },
    firstForkId,
    profile,
    { maxSteps: 2 }
  );
  const second = await wake(
    {
      store,
      tools: [],
      model: new FakeModelProvider([
        { content: "already recorded before fork" },
        { content: "Approach B completed." },
        { finishReason: "done" }
      ])
    },
    secondForkId,
    profile,
    { maxSteps: 2 }
  );
  const unchangedSource = await store.getSession(sourceSessionId);
  const firstAssistant = assistantMessages(first.events).at(-1);
  const secondAssistant = assistantMessages(second.events).at(-1);

  return {
    example: "forked-approaches",
    claim: claimFor("forked-approaches"),
    status: "passed",
    sourceSessionId,
    forkOffset,
    sourceEventCount: unchangedSource.events.length,
    forks: [
      { sessionId: firstForkId, wakeStatus: first.status, eventCount: first.events.length },
      { sessionId: secondForkId, wakeStatus: second.status, eventCount: second.events.length }
    ],
    diverged: firstAssistant === "Approach A completed." && secondAssistant === "Approach B completed."
  };
}

async function runMultiplayerViewerExample(): Promise<ExampleResult> {
  const store = new MemorySessionStore();
  const sessionId = await store.createSession({ metadata: { profileName: "multiplayer-viewer" } });
  const firstEvents = collectEvents(store, sessionId, 4);
  const secondEvents = collectEvents(store, sessionId, 4);
  await store.appendEvent(sessionId, { type: "session.started", profileName: "multiplayer-viewer", mode: "interactive" });
  await store.appendEvent(sessionId, { type: "message.user", content: "watch this" });
  await store.appendEvent(sessionId, { type: "message.assistant", content: "both subscribers see this" });
  await store.appendEvent(sessionId, { type: "system.note", message: "done" });
  const [first, second] = await Promise.all([firstEvents, secondEvents]);

  return {
    example: "multiplayer-viewer",
    claim: claimFor("multiplayer-viewer"),
    status: "passed",
    sessionId,
    subscriberEventTypes: [first, second],
    subscribersMatched: JSON.stringify(first) === JSON.stringify(second)
  };
}

async function runMcpImportExample(): Promise<ExampleResult> {
  process.env.OMA_REFERENCE_MCP_SECRET = "hidden";
  const bundle = await createMcpToolBundle({
    servers: [
      {
        name: "fake",
        command: "bun",
        args: ["--eval", fakeMcpServerScript()],
        env: { OMA_REFERENCE_MCP_VISIBLE: "visible" }
      }
    ]
  });

  try {
    const [tool] = bundle.tools;
    const result = await tool?.handler(
      { text: "hello" },
      { sessionId: "mcp-example", callId: "mcp-call" }
    );

    return {
      example: "mcp-import",
      claim: claimFor("mcp-import"),
      status: "passed",
      toolNames: bundle.tools.map((candidate) => candidate.name),
      result
    };
  } finally {
    delete process.env.OMA_REFERENCE_MCP_SECRET;
    await bundle.close();
  }
}

async function runGitHubPrReviewWebhookExample(): Promise<ExampleResult> {
  const store = new MemorySessionStore();
  const comments = new Map<string, SimulatedComment>();
  const sessionId = "review:owner/repo#42";
  const profile = prReviewProfile();
  await hydrateCommentsFromLog(store, sessionId, comments);
  const body = JSON.stringify({
    action: "synchronize",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 42,
      head: { sha: "head-sha" },
      base: { sha: "base-sha" }
    },
    sender: { login: "octocat" }
  });
  const signal = normalizeGitHubWebhook({
    body,
    secret: "secret",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(body, "secret")
    }
  });
  const route = await routeTriggerSignal(
    {
      store,
      tools: createPrReviewTools(comments),
      model: createPrReviewModelProvider(),
      wakeLock: new MemoryWakeLock()
    },
    {
      on: "github:pull_request.*",
      profile,
      prompt: "Review the GitHub PR webhook payload."
    },
    signal
  );

  return {
    example: "github-pr-review-webhook",
    claim: claimFor("github-pr-review-webhook"),
    status: "passed",
    route,
    normalized: {
      source: signal.source,
      kind: signal.kind,
      deliveryId: signal.deliveryId,
      repo: (signal.payload as { repo?: string }).repo,
      pr: (signal.payload as { pr?: number }).pr
    },
    comments: [...comments.values()]
  };
}

function claimFor(name: ExampleName): string {
  const example = referenceExamples.find((candidate) => candidate.name === name);

  if (!example) {
    throw new Error(`Unknown reference example: ${name}`);
  }

  return example.claim;
}

async function makeExampleProject(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), `oma-${prefix}-`));
  await writeFile(join(cwd, "README.md"), "# Example project\n");
  await writeFile(join(cwd, "index.ts"), "export const value = 1;\n");
  return cwd;
}

function coderProfile(name: string, mode: "interactive" | "job"): Profile {
  return defineProfile({
    name,
    mode,
    systemPrompt: "You are a careful local coding agent.",
    skills: [],
    tools: [
      "read_file",
      "write_file",
      "replace_in_file",
      "list_files",
      "search",
      "bash",
      "run_tests",
      "git_status",
      "git_diff"
    ],
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: { toolError: "fail", maxSteps: 32 }
  });
}

function prReviewProfile(): Profile {
  return defineProfile({
    name: "pr-review",
    mode: "automation",
    systemPrompt:
      "You review pull requests. Comment only on concrete, actionable issues and avoid duplicate findings.",
    skills: [],
    tools: [
      "get_diff",
      "get_file_at_ref",
      "get_pr_metadata",
      "get_prior_comments",
      "post_inline_comment",
      "post_review"
    ],
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: { toolError: "fail", maxSteps: 32 },
    sessionKey: "review:{payload.repo}#{payload.pr}"
  });
}

function toolCalls(events: SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool.call")
    .map((event) => event.toolName);
}

function assistantMessages(events: SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === "message.assistant")
    .map((event) => event.content);
}

function sessionStatus(events: SessionEvent[]): string {
  const last = [...events].reverse().find((event) => event.type.startsWith("run."));
  return last?.type.replace("run.", "") ?? "new";
}

async function collectEvents(
  store: SessionStore,
  sessionId: string,
  count: number
): Promise<string[]> {
  const eventTypes: string[] = [];

  for await (const event of store.subscribe(sessionId, { fromOffset: 0 })) {
    eventTypes.push(event.type);

    if (eventTypes.length >= count) {
      break;
    }
  }

  return eventTypes;
}

class EventRecordingSandboxProvider implements SandboxProvider {
  private readonly local = new LocalSandboxProvider();

  constructor(private readonly store: SessionStore) {}

  async provision(policy: SandboxPolicy, context: SandboxProvisionContext = {}): Promise<Sandbox> {
    const sandbox = await this.local.provision(policy, context);

    if (context.sessionId) {
      await this.store.appendEvent(context.sessionId, {
        type: "sandbox.provisioned",
        sandboxId: sandbox.id,
        kind: sandbox.policy.kind
      });
    }

    return new EventRecordingSandbox(this.store, sandbox, context.sessionId);
  }
}

class EventRecordingSandbox implements Sandbox {
  readonly id: string;
  readonly policy: SandboxPolicy;

  constructor(
    private readonly store: SessionStore,
    private readonly sandbox: Sandbox,
    private readonly sessionId: string | undefined
  ) {
    this.id = sandbox.id;
    this.policy = sandbox.policy;
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const startedAt = Date.now();

    if (this.sessionId) {
      await this.store.appendEvent(this.sessionId, {
        type: "sandbox.exec.started",
        sandboxId: this.id,
        command: request.command,
        args: request.args,
        cwd: request.cwd
      });
    }

    try {
      const result = await this.sandbox.exec(request);

      if (this.sessionId) {
        await this.store.appendEvent(this.sessionId, {
          type: "sandbox.exec.completed",
          sandboxId: this.id,
          command: request.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: Date.now() - startedAt
        });
      }

      return result;
    } catch (error) {
      if (this.sessionId) {
        await this.store.appendEvent(this.sessionId, {
          type: "sandbox.exec.failed",
          sandboxId: this.id,
          command: request.command,
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: String(error) },
          durationMs: Date.now() - startedAt
        });
      }

      throw error;
    }
  }

  async destroy(): Promise<void> {
    await this.sandbox.destroy();

    if (this.sessionId) {
      await this.store.appendEvent(this.sessionId, {
        type: "sandbox.destroyed",
        sandboxId: this.id,
        kind: this.policy.kind
      });
    }
  }
}

function fakeMcpServerScript(): string {
  // MCP stdio framing: newline-delimited JSON, one message per line
  // (matches the @oma/adapter-tools-mcp client).
  return `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  drain();
});
function drain() {
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message.id) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] } });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.text + ":" + (process.env.OMA_REFERENCE_MCP_SECRET ?? "missing") + ":" + (process.env.OMA_REFERENCE_MCP_VISIBLE ?? "missing") }] } });
  }
}
`;
}
