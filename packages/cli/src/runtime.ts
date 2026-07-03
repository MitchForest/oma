import { relative, resolve } from "node:path";
import { FakeModelProvider } from "@oma/adapter-model-fake";
import { AnthropicModelProvider } from "@oma/adapter-model-anthropic";
import { OpenAICompatibleModelProvider } from "@oma/adapter-model-openai-compatible";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { SqliteSessionStore } from "@oma/adapter-session-sqlite";
import { createLocalTools } from "@oma/adapter-tools-local";
import * as issueToPrDemoModels from "@oma/example-issue-to-pr-demo";
import { hostname } from "node:os";
import {
  ClaimWakeLock,
  MemoryWakeLock,
  deriveSessionStatus,
  errorToRecord,
  hasRunClaims,
  indexTools,
  resolveSessionKey,
  routeTriggerSignal,
  spawn,
  wake,
  type AnyTool,
  type HarnessRuntime,
  type ModelProvider,
  type ModelTurn,
  type Profile,
  type Sandbox,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxPolicy,
  type SandboxProvider,
  type SandboxProvisionContext,
  type SessionEvent,
  type SessionStore,
  type ToolRegistry,
  type TriggerRouteResult,
  type TriggerSignal,
  type WakeLock,
  type WakeResult
} from "@oma/core";
import {
  buildContextPack,
  compileWorkflow,
  contextPackEvent,
  isWorkflowPath,
  matchesWorkflowSignal,
  parseDuration,
  parseTokenCount,
  renderContextSection,
  requireLoadedWorkflow,
  resolveWorkflowName,
  runWorkflowStages,
  type CompiledAgent,
  type LoadedWorkflow,
  type StageRunResult,
  type StageRuntimeFactory,
  type WorkflowData
} from "@oma/workflows";
import { resolveSecretRefs } from "./secrets";
import {
  bundleSandboxPolicy,
  loadConfig,
  profileSandboxPolicy,
  resolveSandboxPolicy,
  type RuntimeConfig
} from "./config";

export interface RuntimeBundle {
  config: RuntimeConfig;
  store: SessionStore;
  runtime: HarnessRuntime;
  mcpTools: AnyTool[];
  sandboxes: Set<Sandbox>;
  close(): Promise<void>;
}

export interface StoreBundle {
  config: RuntimeConfig;
  store: SessionStore;
  close(): Promise<void>;
}

const openBundles = new Set<{ close(): Promise<void> }>();

export interface LoadRuntimeOptions {
  /** Identity used for durable run claims; defaults to cli:<host>:<pid>. */
  workerId?: string;
}

export async function loadRuntime(
  configPath = ".oma/config.json",
  options: LoadRuntimeOptions = {}
): Promise<RuntimeBundle> {
  const config = await loadConfig(configPath);
  const store = await createSessionStore(config.store);
  return createRuntimeBundle(config, store, {
    includeMcp: true,
    includeSandbox: true,
    workerId: options.workerId
  });
}

/**
 * Store-only path for read commands (show/list/fork/tail/store): no MCP
 * servers are spawned and no model providers are constructed.
 */
export async function loadStoreBundle(configPath = ".oma/config.json"): Promise<StoreBundle> {
  const config = await loadConfig(configPath);
  const store = await createSessionStore(config.store);
  const bundle: StoreBundle = {
    config,
    store,
    close: () => closeStore(store)
  };

  openBundles.add(bundle);
  return bundle;
}

export async function loadAuthoringRuntime(
  configPath = ".oma/config.json"
): Promise<RuntimeBundle> {
  const config = await loadConfig(configPath);
  return createRuntimeBundle(config, new MemorySessionStore(), {
    includeMcp: false,
    includeSandbox: false
  });
}

async function createRuntimeBundle(
  config: RuntimeConfig,
  store: SessionStore,
  options: {
    includeMcp: boolean;
    includeSandbox: boolean;
    wakeLock?: WakeLock;
    workerId?: string;
  }
): Promise<RuntimeBundle> {
  const sandboxes = new Set<Sandbox>();
  const tools = createLocalTools({
    cwd: resolve(String(config.sandbox.cwd ?? ".")),
    testCommand: config.tools?.testCommand,
    timeoutMs: config.tools?.timeoutMs,
    outputLimitBytes: config.tools?.outputLimitBytes,
    allowedCommands: config.tools?.allowedCommands,
    env: config.tools?.env,
    sandboxProvider: options.includeSandbox
      ? new TrackedSandboxProvider(bundleSandboxPolicy(config), store, sandboxes)
      : undefined,
    sandboxPolicy: bundleSandboxPolicy(config)
  });
  let mcpBundle: { close(): Promise<void>; tools: AnyTool[] } | undefined;

  if (options.includeMcp && config.tools?.mcp?.servers.length) {
    const { createMcpToolBundle } = await import("@oma/adapter-tools-mcp");
    mcpBundle = await createMcpToolBundle({ servers: config.tools.mcp.servers });
    tools.push(...mcpBundle.tools);
  }

  const model =
    config.model.kind === "openai-compatible"
      ? new OpenAICompatibleModelProvider({
          model: config.model.model,
          baseUrl: config.model.baseUrl,
          apiKey: process.env[config.model.apiKeyEnv ?? "OPENAI_API_KEY"],
          temperature: config.model.temperature,
          maxOutputTokens: config.model.maxOutputTokens
        })
      : config.model.kind === "anthropic"
        ? new AnthropicModelProvider({
            model: config.model.model,
            baseUrl: config.model.baseUrl,
            apiKey: process.env[config.model.apiKeyEnv ?? "ANTHROPIC_API_KEY"],
            temperature: config.model.temperature,
            maxOutputTokens: config.model.maxOutputTokens
          })
      : new FakeModelProvider(defaultFakeTurns());
  // The wake lock is an explicit part of bundle construction. Stores with
  // run claims get the durable ClaimWakeLock: in-process wakes queue, and a
  // store-backed lease keeps two processes (CLI + worker, or two workers)
  // from waking the same session concurrently. Stores without claims keep
  // the in-process-only MemoryWakeLock.
  const wakeLock =
    options.wakeLock ??
    (hasRunClaims(store)
      ? new ClaimWakeLock(store, options.workerId ?? defaultWorkerId(), {
          isStale: isStaleLocalCliClaim
        })
      : new MemoryWakeLock());
  const bundle: RuntimeBundle = {
    config,
    store,
    mcpTools: mcpBundle?.tools ?? [],
    sandboxes,
    runtime: {
      store,
      model,
      tools,
      wakeLock
    },
    close: async () => {
      await mcpBundle?.close();
      await Promise.all([...sandboxes].map((sandbox) => sandbox.destroy()));
      await closeStore(store);
    }
  };
  openBundles.add(bundle);
  return bundle;
}

export interface AgentRuntimeOptions {
  sessionId?: string;
  /** Resolved secret values (never logged): tool clients read them by name. */
  secrets?: Record<string, string>;
  /** Secret names additionally injected into the sandbox environment. */
  exposeSecrets?: string[];
  /** Authoring flows (validate): construct tool clients without credentials. */
  allowMissingCredentials?: boolean;
}

/**
 * Builds the per-wake runtime for a compiled inline agent: local tools bound
 * to the agent's sandbox, GitHub tools when declared, MCP tools, and the
 * agent's model routing (provider model name or module://pkg#export).
 */
export async function runtimeForAgent(
  bundle: RuntimeBundle,
  agent: CompiledAgent,
  options: AgentRuntimeOptions = {}
): Promise<{ runtime: HarnessRuntime; profile: Profile }> {
  const profile = agent.profile;
  const tools = [
    ...createProfileLocalTools(profile, bundle, options.sessionId, options),
    ...bundle.mcpTools
  ];

  tools.push(...(await createProfileGitHubTools(profile, bundle, tools, options)));

  const model = await resolveModel(bundle.config, agent.model);

  // A per-wake runtime instead of mutating the shared bundle: with concurrent
  // wakes (ui/serve), mutating bundle.runtime would wire session A's sandbox
  // tracker into session B's wake.
  return {
    runtime: { ...bundle.runtime, tools, ...(model ? { model } : {}) },
    profile
  };
}

/** Declared tools this runtime cannot provide — authoring-time diagnostics. */
export function missingAgentTools(profile: Profile, tools: ToolRegistry): string[] {
  const registry = indexTools(tools);
  return profile.tools.filter((name) => !registry.has(name));
}

export interface TriggerRouteOutput {
  route: TriggerRouteResult;
  status?: string;
  events?: SessionEvent[];
}

/**
 * Resolves a CLI target to a workflow file: an explicit `.yml`/`.yaml` path,
 * or a bare name looked up in `.oma/workflows/`.
 */
export async function resolveWorkflowTarget(target: string): Promise<string | undefined> {
  if (isWorkflowPath(target)) {
    return target;
  }

  if (!target.includes("/") && !target.includes(".")) {
    return resolveWorkflowName(target);
  }

  return undefined;
}

export interface WorkflowRouteOptions {
  maxSteps?: number;
  /** Route and record the signal without starting the model/tool loop. */
  noWake?: boolean;
  /** Reuse an already-loaded workflow instead of re-reading disk. */
  preloaded?: LoadedWorkflow;
  /** Placement identity of this process: "local" (default) or "worker:<name>". */
  placement?: string;
}

export interface WorkflowRouteOutput extends TriggerRouteOutput {
  workflow: WorkflowData;
  sessionId?: string;
  awaiting?: { stage: string; iteration: number };
  reason?: string;
}

export async function routeWorkflowSignal(
  bundle: RuntimeBundle,
  workflowPath: string,
  signal: TriggerSignal,
  options: WorkflowRouteOptions = {}
): Promise<WorkflowRouteOutput> {
  const loaded =
    options.preloaded && options.preloaded.workflow && options.preloaded.sourceHash
      ? (options.preloaded as LoadedWorkflow & { workflow: WorkflowData; sourceHash: string })
      : await requireLoadedWorkflow(workflowPath);

  if (loaded.workflow.stages) {
    return routeStagedWorkflow(bundle, loaded, signal, options);
  }

  const defaultAgent = loaded.agents?.default;

  if (!defaultAgent) {
    throw new Error(`Workflow ${loaded.workflow.name} declares no agent.`);
  }

  const sessionTemplate = loaded.workflow.trigger?.session;
  let sessionId: string;
  let sessionKeyOverride: string | null | undefined;

  try {
    sessionId = await resolveSessionKey(sessionTemplate, signal);
  } catch (error) {
    if (signal.source !== "manual") {
      throw error;
    }

    // Ad-hoc manual run of a webhook-keyed workflow: the session template
    // references payload fields the operator did not pass. Fall back to a
    // fresh session instead of failing the run.
    sessionId = crypto.randomUUID();
    sessionKeyOverride = null;
  }

  const secrets = !options.noWake && loaded.workflow.env
    ? await resolveSecretRefs(loaded.workflow.env.secrets)
    : undefined;
  const { runtime, profile } = await runtimeForAgent(bundle, defaultAgent, {
    sessionId,
    secrets,
    exposeSecrets: options.noWake ? undefined : loaded.workflow.env?.expose,
    allowMissingCredentials: options.noWake
  });
  const compiled = compileWorkflow(loaded.workflow, {
    profile,
    sourceHash: loaded.sourceHash,
    sourcePath: loaded.path,
    sessionKey: sessionKeyOverride
  });

  // A declared context block builds a fresh pack per routed signal: the pack
  // event lands in the log and the rendered section rides in the prompt, so
  // the session records exactly what the model was shown and why it fit.
  let promptPrefix = "";
  let contextEvents: ReturnType<typeof contextPackEvent>[] = [];

  if (loaded.workflow.context) {
    const pack = await buildContextPack(loaded.workflow.context);
    promptPrefix = `${renderContextSection(pack)}\n\n`;
    contextEvents = [contextPackEvent(pack)];
  }

  for (const trigger of compiled.triggers) {
    const promptWithContext = promptPrefix
      ? async (routedSignal: TriggerSignal) => {
          const base =
            typeof trigger.prompt === "function"
              ? await trigger.prompt(routedSignal)
              : trigger.prompt;
          return `${promptPrefix}${base}`;
        }
      : trigger.prompt;
    const route = await routeTriggerSignal(runtime, { ...trigger, prompt: promptWithContext }, signal, {
      maxSteps: options.maxSteps ?? compiled.maxSteps,
      tokenBudget: compiled.budget?.tokens,
      deadlineAt:
        compiled.budget?.wallMs !== undefined ? Date.now() + compiled.budget.wallMs : undefined,
      fallbackSessionId: () => sessionId,
      spawnEvents: compiled.spawnEvents,
      signalEvents: [...compiled.signalEvents(signal), ...contextEvents],
      noWake: options.noWake,
      sessionMetadata: {
        workflowPath: portablePath(loaded.path),
        workflowName: loaded.workflow.name
      }
    });

    if (route.type === "ignored") {
      continue;
    }

    if (route.type === "filtered") {
      return { route, workflow: loaded.workflow };
    }

    const session = await bundle.store.getSession(route.sessionId);

    return {
      route,
      workflow: loaded.workflow,
      sessionId: route.sessionId,
      status: deriveSessionStatus(session.events),
      events: session.events
    };
  }

  return { route: { type: "ignored" }, workflow: loaded.workflow };
}

/**
 * Staged workflows do not wake a model on the parent session: the parent log
 * is the orchestration trace and the stage runner does the work, spawning one
 * durable child session per stage.
 */
async function routeStagedWorkflow(
  bundle: RuntimeBundle,
  loaded: LoadedWorkflow & { workflow: WorkflowData; sourceHash: string },
  signal: TriggerSignal,
  options: WorkflowRouteOptions
): Promise<WorkflowRouteOutput> {
  const workflow = loaded.workflow;
  // The parent session never wakes a model; any agent's profile serves for
  // the session.started record.
  const anyAgent =
    loaded.agents?.default ?? Object.values(loaded.agents?.stages ?? {})[0];

  if (!anyAgent) {
    throw new Error(`Workflow ${workflow.name} declares no agents.`);
  }

  if (!matchesWorkflowSignal(workflow, signal)) {
    return { route: { type: "ignored" }, workflow };
  }

  const sessionTemplate = workflow.trigger?.session;
  let sessionId: string;

  try {
    sessionId = await resolveSessionKey(sessionTemplate, signal);
  } catch (error) {
    if (signal.source !== "manual") {
      throw error;
    }

    sessionId = crypto.randomUUID();
  }

  const run = async (): Promise<WorkflowRouteOutput> => {
    const exists = await bundle.store.exists(sessionId);

    if (!exists) {
      await spawn(bundle.store, anyAgent.profile, {
        id: sessionId,
        metadata: {
          workflowKind: "staged",
          workflowName: workflow.name,
          workflowPath: portablePath(loaded.path)
        }
      });
      await bundle.store.appendEvent(sessionId, {
        type: "workflow.loaded",
        name: workflow.name,
        title: workflow.title,
        sourcePath: loaded.path,
        sourceHash: loaded.sourceHash
      });
    }

    await bundle.store.appendEvent(sessionId, {
      type: "workflow.run.started",
      name: workflow.name,
      sourceHash: loaded.sourceHash,
      trigger: { source: signal.source, kind: signal.kind },
      inputs:
        signal.source === "manual" && signal.payload && typeof signal.payload === "object"
          ? (signal.payload as Record<string, unknown>)
          : undefined
    });
    await bundle.store.appendEvent(sessionId, {
      type: "trigger.received",
      source: signal.source,
      kind: signal.kind,
      payload: signal.payload,
      deliveryId: signal.deliveryId,
      receivedAt: signal.receivedAt,
      metadata: signal.metadata
    });

    const result = await runWorkflowStages(
      {
        store: bundle.store,
        factory: await stageFactory(bundle, loaded),
        maxSteps: options.maxSteps,
        budget: workflowBudget(workflow),
        placement: options.placement
      },
      workflow,
      {
        parentSessionId: sessionId,
        sourceHash: loaded.sourceHash,
        codeModulePath: loaded.runModulePath
      }
    );

    const session = await bundle.store.getSession(sessionId);

    return {
      route: { type: exists ? "woken" : "spawned", sessionId },
      workflow,
      sessionId,
      status: result.status,
      awaiting: result.awaiting,
      reason: result.reason,
      events: session.events
    };
  };

  const wakeLock = bundle.runtime.wakeLock;
  return wakeLock ? wakeLock.withSessionLock(sessionId, run) : run();
}

async function stageFactory(
  bundle: RuntimeBundle,
  loaded: LoadedWorkflow & { workflow: WorkflowData; sourceHash: string }
): Promise<StageRuntimeFactory> {
  const secrets = loaded.workflow.env
    ? await resolveSecretRefs(loaded.workflow.env.secrets)
    : undefined;
  const exposeSecrets = loaded.workflow.env?.expose;
  // The workflow's effects policy applies to every stage: the file a reviewer
  // reads is the file that binds, regardless of which profile a stage uses.
  const effects = loaded.workflow.policy.effects;

  return async ({ name, sessionId }) => {
    const agent = loaded.agents?.stages[name] ?? loaded.agents?.default;

    if (!agent) {
      throw new Error(`Stage "${name}" of ${loaded.workflow.name} has no agent.`);
    }

    const { runtime, profile } = await runtimeForAgent(bundle, agent, {
      sessionId,
      secrets,
      exposeSecrets
    });

    return {
      runtime,
      profile: effects
        ? {
            ...profile,
            policy: {
              ...profile.policy,
              effects: { ...profile.policy.effects, ...effects }
            }
          }
        : profile
    };
  };
}

function workflowBudget(
  workflow: WorkflowData
): { tokens?: number; wallMs?: number } | undefined {
  if (!workflow.policy.budget) {
    return undefined;
  }

  return {
    tokens:
      workflow.policy.budget.tokens !== undefined
        ? parseTokenCount(workflow.policy.budget.tokens)
        : undefined,
    wallMs:
      workflow.policy.budget.wall !== undefined
        ? parseDuration(workflow.policy.budget.wall)
        : undefined
  };
}

export interface WorkflowResumeOutput {
  sessionId: string;
  result: StageRunResult;
}

/**
 * Resumes a workflow session from its durable log (wake/approve/deny). The
 * workflow file is re-read, so raising a budget or editing policy in the YAML
 * applies to the resumed run — and the recorded source hash states which
 * version handled it.
 */
export async function resumeWorkflowSession(
  bundle: RuntimeBundle,
  sessionId: string,
  options: { placement?: string } = {}
): Promise<WorkflowResumeOutput> {
  const session = await bundle.store.getSession(sessionId);
  const workflowPath = session.metadata?.workflowPath;

  if (typeof workflowPath !== "string") {
    throw new Error(`Session ${sessionId} is not a workflow session.`);
  }

  const loaded = await requireLoadedWorkflow(workflowPath);

  if (!loaded.workflow.stages) {
    return resumeSingleStageWorkflow(bundle, sessionId, loaded);
  }

  const factory = await stageFactory(bundle, loaded);
  const run = () =>
    runWorkflowStages(
      {
        store: bundle.store,
        factory,
        budget: workflowBudget(loaded.workflow),
        placement: options.placement
      },
      loaded.workflow,
      {
        parentSessionId: sessionId,
        sourceHash: loaded.sourceHash,
        codeModulePath: loaded.runModulePath
      }
    );
  const wakeLock = bundle.runtime.wakeLock;
  const result = wakeLock ? await wakeLock.withSessionLock(sessionId, run) : await run();

  return { sessionId, result };
}

async function resumeSingleStageWorkflow(
  bundle: RuntimeBundle,
  sessionId: string,
  loaded: LoadedWorkflow & { workflow: WorkflowData; sourceHash: string }
): Promise<WorkflowResumeOutput> {
  const defaultAgent = loaded.agents?.default;

  if (!defaultAgent) {
    throw new Error(`Workflow ${loaded.workflow.name} declares no agent.`);
  }

  const secrets = loaded.workflow.env
    ? await resolveSecretRefs(loaded.workflow.env.secrets)
    : undefined;
  const { runtime, profile } = await runtimeForAgent(bundle, defaultAgent, {
    sessionId,
    secrets,
    exposeSecrets: loaded.workflow.env?.expose
  });
  const compiled = compileWorkflow(loaded.workflow, {
    profile,
    sourceHash: loaded.sourceHash,
    sourcePath: loaded.path
  });
  const wakeResult = await wake(runtime, sessionId, compiled.profile, {
    maxSteps: compiled.maxSteps,
    tokenBudget: compiled.budget?.tokens,
    deadlineAt:
      compiled.budget?.wallMs !== undefined ? Date.now() + compiled.budget.wallMs : undefined
  });

  return { sessionId, result: wakeResultToRunResult(sessionId, wakeResult) };
}

function wakeResultToRunResult(
  sessionId: string,
  result: WakeResult
): StageRunResult {
  if (result.status === "completed") {
    return { status: "completed" };
  }

  if (result.status === "waiting" && result.waitingOn?.type === "approval") {
    return {
      status: "paused",
      reason: `Tool "${result.waitingOn.toolName}" awaits approval — decide with: oma approve ${sessionId} | oma deny ${sessionId}`
    };
  }

  if (result.status === "paused") {
    return { status: "paused", reason: result.pauseReason };
  }

  if (result.status === "waiting") {
    return { status: "paused", reason: `waiting on ${result.waitingOn?.type ?? "input"}` };
  }

  return { status: "failed", reason: "Run failed; see session events." };
}


/**
 * Resumes whatever kind of workflow session this id names: workflow parents
 * and single-stage sessions resume through their file; stage sessions resume
 * their parent (the runner owns stage wakes). This is the one path behind
 * wake, send, approve, the UI, and workers.
 */
export async function resumeSessionSmart(
  bundle: RuntimeBundle,
  sessionId: string,
  options: { placement?: string } = {}
): Promise<WorkflowResumeOutput> {
  const session = await bundle.store.getSession(sessionId);

  if (typeof session.metadata?.workflowPath === "string") {
    return resumeWorkflowSession(bundle, sessionId, options);
  }

  if (typeof session.metadata?.parentSessionId === "string") {
    return resumeWorkflowSession(bundle, session.metadata.parentSessionId, options);
  }

  throw new Error(
    `Session ${sessionId} is not a workflow session; workflows are the only way to run agents.`
  );
}

/**
 * Model routing, one string with three schemes:
 * - a plain name targets the configured provider;
 * - `claude-code:<model>` / `codex:<model>[#<effort>]` ride the coding-agent
 *   CLIs the user is already logged into — no API keys, the existing
 *   subscription is the credential;
 * - `module://<pkg>#<export>` loads a provider factory (code execution — the
 *   same trust level as `run:` code workflows).
 * The fake provider ignores plain overrides so workflows stay runnable
 * without credentials.
 */
async function resolveModel(
  config: RuntimeConfig,
  model?: string
): Promise<ModelProvider | undefined> {
  if (!model) {
    return undefined;
  }

  if (model.startsWith("claude-code:")) {
    const { createClaudeCodeModel } = await import("@oma/adapter-model-cli");
    const name = model.slice("claude-code:".length);
    return createClaudeCodeModel(name ? { model: name } : {});
  }

  if (model.startsWith("codex:")) {
    const { createCodexModel } = await import("@oma/adapter-model-cli");
    const [name, effort] = model.slice("codex:".length).split("#", 2);
    return createCodexModel({
      ...(name ? { model: name } : {}),
      ...(effort ? { effort } : {})
    });
  }

  if (model.startsWith("module://")) {
    const reference = model.slice("module://".length);
    const [moduleName, exportName] = reference.split("#", 2);

    if (!moduleName || !exportName) {
      throw new Error(`Model modules look like module://<package>#<export>, got: ${model}`);
    }

    const loadedModule =
      moduleName === "@oma/example-issue-to-pr-demo"
        ? (issueToPrDemoModels as Record<string, unknown>)
        : ((await import(moduleName)) as Record<string, unknown>);
    const factory = loadedModule[exportName];

    if (typeof factory !== "function") {
      throw new Error(`Model module ${moduleName} has no factory export "${exportName}".`);
    }

    return factory() as ModelProvider;
  }

  if (config.model.kind === "openai-compatible") {
    return new OpenAICompatibleModelProvider({
      model,
      baseUrl: config.model.baseUrl,
      apiKey: process.env[config.model.apiKeyEnv ?? "OPENAI_API_KEY"],
      temperature: config.model.temperature,
      maxOutputTokens: config.model.maxOutputTokens
    });
  }

  if (config.model.kind === "anthropic") {
    return new AnthropicModelProvider({
      model,
      baseUrl: config.model.baseUrl,
      apiKey: process.env[config.model.apiKeyEnv ?? "ANTHROPIC_API_KEY"],
      temperature: config.model.temperature,
      maxOutputTokens: config.model.maxOutputTokens
    });
  }

  return undefined;
}

interface ToolsForProfileOptions {
  allowMissingCredentials?: boolean;
  secrets?: Record<string, string>;
  exposeSecrets?: string[];
}

/**
 * GitHub tools are constructed only for profiles that declare them. The token
 * is required at run time; authoring flows (validate/inspect) pass
 * allowMissingCredentials so tool-presence checks work without credentials.
 */
async function createProfileGitHubTools(
  profile: Profile,
  bundle: RuntimeBundle,
  existingTools: AnyTool[],
  options: ToolsForProfileOptions
): Promise<AnyTool[]> {
  const githubConfig = bundle.config.tools?.github;

  if (!githubConfig) {
    return [];
  }

  const { createGitHubTools, githubToolNames } = await import("@oma/adapter-tools-github");
  const provided = new Set(existingTools.map((tool) => tool.name));
  const wantsGitHub = profile.tools.some(
    (name) => !provided.has(name) && (githubToolNames as readonly string[]).includes(name)
  );

  if (!wantsGitHub) {
    return [];
  }

  const tokenEnv = githubConfig.tokenEnv ?? "GITHUB_TOKEN";
  // Workflow-scoped secret refs take precedence over ambient environment.
  const token = options.secrets?.[tokenEnv] ?? process.env[tokenEnv];

  if (!token) {
    if (options.allowMissingCredentials) {
      return createGitHubTools({ token: "missing-token", baseUrl: githubConfig.baseUrl });
    }

    throw new Error(
      `Profile "${profile.name}" declares GitHub tools but ${tokenEnv} is not set.`
    );
  }

  return createGitHubTools({ token, baseUrl: githubConfig.baseUrl });
}

function createProfileLocalTools(
  profile: Profile,
  bundle: RuntimeBundle,
  sessionId?: string,
  options: ToolsForProfileOptions = {}
): AnyTool[] {
  const policy = profileSandboxPolicy(profile, bundle.config);
  // Only explicitly exposed secrets reach the sandbox environment; everything
  // else stays harness-side.
  const exposed: Record<string, string> = {};

  for (const name of options.exposeSecrets ?? []) {
    const value = options.secrets?.[name];

    if (value !== undefined) {
      exposed[name] = value;
    }
  }

  const baseEnv = policy.env ?? bundle.config.tools?.env;
  const env =
    Object.keys(exposed).length > 0 ? { ...baseEnv, ...exposed } : baseEnv;

  return createLocalTools({
    cwd: resolve(String(policy.cwd ?? ".")),
    testCommand: bundle.config.tools?.testCommand,
    timeoutMs: policy.timeoutMs ?? bundle.config.tools?.timeoutMs,
    outputLimitBytes: policy.outputLimitBytes ?? bundle.config.tools?.outputLimitBytes,
    allowedCommands: policy.allowedCommands ?? bundle.config.tools?.allowedCommands,
    env,
    sandboxProvider: new TrackedSandboxProvider(
      env ? { ...policy, env } : policy,
      bundle.store,
      bundle.sandboxes,
      sessionId
    ),
    sandboxPolicy: env ? { ...policy, env } : policy
  });
}

async function createSessionStore(config: RuntimeConfig["store"]): Promise<SessionStore> {
  if (config.kind === "memory") {
    return new MemorySessionStore();
  }

  if (config.kind === "sqlite") {
    return new SqliteSessionStore(resolve(config.path));
  }

  const connectionString =
    config.connectionString ??
    (config.connectionStringEnv ? process.env[config.connectionStringEnv] : undefined);

  if (!connectionString) {
    throw new Error(
      `Missing Postgres connection string. Set ${config.connectionStringEnv ?? "DATABASE_URL"} or store.connectionString.`
    );
  }

  const { PostgresSessionStore } = await import("@oma/adapter-session-postgres");
  return new PostgresSessionStore({
    connectionString,
    pollMs: config.pollMs
  });
}

async function closeStore(store: SessionStore): Promise<void> {
  const close = (store as { close?: () => void | Promise<void> }).close;

  if (typeof close === "function") {
    await close.call(store);
  }
}

export async function closeOpenBundles(): Promise<void> {
  const bundles = [...openBundles];
  openBundles.clear();

  await Promise.all(bundles.map((bundle) => bundle.close()));
}

export async function createSandbox(policy: SandboxPolicy): Promise<Sandbox> {
  const provider = await createSandboxProvider(policy.kind);
  return provider.provision(policy);
}

async function createSandboxProvider(kind: string): Promise<SandboxProvider> {
  if (kind === "local") {
    const { LocalSandboxProvider } = await import("@oma/adapter-sandbox-local");
    return new LocalSandboxProvider();
  }

  if (kind === "worktree") {
    const { WorktreeSandboxProvider } = await import("@oma/adapter-sandbox-worktree");
    return new WorktreeSandboxProvider();
  }

  if (kind === "docker") {
    const { DockerSandboxProvider } = await import("@oma/adapter-sandbox-docker");
    return new DockerSandboxProvider();
  }

  throw new Error(`Unsupported sandbox kind: ${kind}`);
}

class TrackedSandboxProvider implements SandboxProvider {
  constructor(
    private readonly defaultPolicy: SandboxPolicy,
    private readonly store: SessionStore,
    private readonly sandboxes: Set<Sandbox>,
    private readonly sessionId?: string
  ) {}

  async provision(
    policy: SandboxPolicy = this.defaultPolicy,
    context: SandboxProvisionContext = {}
  ): Promise<Sandbox> {
    const resolvedPolicy = resolveSandboxPolicy({
      ...this.defaultPolicy,
      ...policy
    });
    const provider = await createSandboxProvider(resolvedPolicy.kind);
    const sandbox = await provider.provision(resolvedPolicy, context);
    const observed = new TrackedSandbox(
      sandbox,
      this.store,
      context.sessionId ?? this.sessionId,
      () => this.sandboxes.delete(observed)
    );

    this.sandboxes.add(observed);
    await observed.recordProvisioned();
    return observed;
  }
}

class TrackedSandbox implements Sandbox {
  readonly id: string;
  readonly policy: SandboxPolicy;
  private destroyed = false;

  constructor(
    private readonly inner: Sandbox,
    private readonly store: SessionStore,
    private readonly sessionId: string | undefined,
    private readonly onDestroy: () => void
  ) {
    this.id = inner.id;
    this.policy = inner.policy;
  }

  async recordProvisioned(): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    await this.store.appendEvent(this.sessionId, {
      type: "sandbox.provisioned",
      sandboxId: this.id,
      kind: this.policy.kind,
      metadata: sandboxMetadata(this.policy)
    });
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    const startedAt = performance.now();

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
      const result = await this.inner.exec(request);

      if (this.sessionId) {
        await this.store.appendEvent(this.sessionId, {
          type: "sandbox.exec.completed",
          sandboxId: this.id,
          command: request.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          durationMs: Math.round(performance.now() - startedAt)
        });
      }

      return result;
    } catch (error) {
      if (this.sessionId) {
        await this.store.appendEvent(this.sessionId, {
          type: "sandbox.exec.failed",
          sandboxId: this.id,
          command: request.command,
          error: errorToRecord(error),
          durationMs: Math.round(performance.now() - startedAt)
        });
      }

      throw error;
    }
  }

  async destroy(options?: { outcome?: "success" | "failure" }): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;

    try {
      await this.inner.destroy(options);

      if (this.sessionId) {
        await this.store.appendEvent(this.sessionId, {
          type: "sandbox.destroyed",
          sandboxId: this.id,
          kind: this.policy.kind,
          metadata: sandboxMetadata(this.policy)
        });
      }
    } finally {
      this.onDestroy();
    }
  }
}

function sandboxMetadata(policy: SandboxPolicy): Record<string, unknown> {
  return {
    cwd: policy.cwd,
    allowedCommands: policy.allowedCommands,
    timeoutMs: policy.timeoutMs,
    outputLimitBytes: policy.outputLimitBytes,
    network: policy.network,
    cleanup: policy.cleanup
  };
}

function defaultWorkerId(): string {
  return `cli:${hostname()}:${process.pid}`;
}

/**
 * A lease held by a CLI process on this same host whose pid no longer exists
 * is provably dead — take it over instead of waiting out the TTL. Worker
 * leases (`worker:<name>`) and other hosts' CLIs can't be liveness-checked
 * here and always wait for expiry.
 */
function isStaleLocalCliClaim(claim: { workerId: string }): boolean {
  const match = /^cli:([^:]+):(\d+)$/.exec(claim.workerId);

  if (!match || match[1] !== hostname()) {
    return false;
  }

  try {
    process.kill(Number(match[2]), 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Paths recorded in session metadata are cwd-relative when possible, so a
 * worker on another machine running from its own checkout of the same repo
 * resolves them.
 */
function portablePath(path: string): string {
  const relativePath = relative(process.cwd(), path);
  return relativePath.startsWith("..") ? path : relativePath;
}


function defaultFakeTurns(): ModelTurn[] {
  return [
    {
      toolCalls: [{ name: "list_files", args: { maxResults: 40 } }]
    },
    {
      toolCalls: [{ name: "git_status", args: {} }]
    },
    {
      content:
        "Local fake run completed. Configure a real model adapter to turn this durable runtime into an autonomous agent."
    },
    {
      finishReason: "done"
    }
  ];
}
