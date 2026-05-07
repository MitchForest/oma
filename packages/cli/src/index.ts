#!/usr/bin/env bun
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  objective,
  outcomes,
  replay,
  replayOutcome,
  resume,
  run,
  sessions,
  validateArtifacts,
} from "@oma/runtime";
import type { Artifact, OutcomeStatus, StoredEvent, ValidationResult } from "@oma/runtime";
import { formatValidationSummary } from "@oma/validators";
import { flag, hasFlag, parseArgs } from "./args";
import { CliError, messageFrom } from "./errors";
import {
  createEnvironment,
  createHarness,
  createSessionStore,
  createValidators,
  defaultConfigPath,
  isHarnessKind,
  listRunRecords,
  loadProject,
  localEvents,
  localOutcome,
  requireRunRecord,
  sessionForId,
  writeDefaultProjectConfig,
  writeOutcomeFiles,
  writeValidationReport,
} from "@oma/project";
import { errorText, json, text } from "./output";
import type { Output } from "./output";
import type { HarnessKind, ResolvedProject, ValidationReport } from "@oma/project";

export type CliInput = {
  argv: string[];
  cwd: string;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const version = "0.0.0";

const help = `OMA

Usage:
  oma init [--harness codex-cli]
  oma doctor [--json]
  oma run "objective text" [--json]
  oma inspect <run-id> [--json]
  oma replay <run-id|session-id> [--json]
  oma resume <run-id|session-id> [--json]
  oma validate <run-id> [--json]
  oma runs [--json] [--api <url>]
  oma watch <run-id> [--api <url>]
  oma events <run-id> [--json] [--type <event-type>] [--api <url>]
  oma artifacts <run-id> [--json] [--api <url>]
  oma artifact <run-id> <artifact-id|name> [--output <path>] [--api <url>]
  oma validation <run-id> [--json] [--api <url>]
  oma outcome <run-id> [--json] [--api <url>]

Global:
  --config <path>
  --api <url>
  --json
  --help
  --version`;

const defaultTextLimit = 4_000;

function isSucceeded(status: OutcomeStatus): boolean {
  return status === "succeeded";
}

function statusFromValidation(validation: ValidationReport["validation"]): OutcomeStatus {
  if (validation.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (validation.some((result) => result.status === "inconclusive")) {
    return "inconclusive";
  }
  return "succeeded";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function jsonOutput(args: ReturnType<typeof parseArgs>): boolean {
  return hasFlag(args, "json");
}

function configPath(args: ReturnType<typeof parseArgs>): string | undefined {
  return flag(args, "config");
}

function apiBaseUrl(args: ReturnType<typeof parseArgs>): string | undefined {
  return flag(args, "api")?.replace(/\/$/, "");
}

function expanded(args: ReturnType<typeof parseArgs>): boolean {
  return hasFlag(args, "full");
}

async function loadResolvedProject(
  args: ReturnType<typeof parseArgs>,
  cwd: string,
): Promise<ResolvedProject> {
  const path = configPath(args);
  return path ? await loadProject({ cwd, configPath: path }) : await loadProject({ cwd });
}

async function apiJson<T>(api: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${api}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new CliError(body.error?.message ?? `HTTP ${String(response.status)} ${path}`);
  }
  return body as T;
}

async function apiText(api: string, path: string): Promise<{ content: string; mediaType: string }> {
  const response = await fetch(`${api}${path}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new CliError(body.error?.message ?? `HTTP ${String(response.status)} ${path}`);
  }
  return {
    content: await response.text(),
    mediaType: response.headers.get("content-type") ?? "text/plain",
  };
}

function truncate(textValue: string, limit = defaultTextLimit): string {
  if (textValue.length <= limit) {
    return textValue;
  }
  return `${textValue.slice(0, limit)}\n... truncated ${String(textValue.length - limit)} chars`;
}

function preview(value: string, limit = 72): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return `${oneLine.slice(0, limit - 1)}…`;
}

function formatAge(at: string): string {
  const timestamp = Date.parse(at);
  if (Number.isNaN(timestamp)) {
    return at;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h`;
  }
  return `${String(Math.floor(hours / 24))}d`;
}

function eventLine(event: StoredEvent): string {
  const label =
    event.type === "harness.observed" && "label" in event.data && event.data.label
      ? ` ${String(event.data.label)}`
      : "";
  const summary =
    event.type === "harness.observed" && "summary" in event.data && event.data.summary
      ? ` - ${preview(String(event.data.summary), 100)}`
      : "";
  return `${String(event.sequence).padStart(4, " ")} ${event.type}${label}${summary}`;
}

function artifactSize(artifact: Artifact): number {
  return Buffer.byteLength(artifact.content, "utf8");
}

function validationLines(validation: ValidationResult[], full: boolean): string[] {
  return formatValidationSummary(validation, { full });
}

function findArtifact(artifacts: Artifact[], selector: string): Artifact | undefined {
  return artifacts.find((artifact) => artifact.id === selector || artifact.name === selector);
}

async function commandInit(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const harness = flag(input.args, "harness") ?? "codex-cli";
  if (!isHarnessKind(harness)) {
    throw new CliError(`Unsupported harness: ${harness}`);
  }
  const force = hasFlag(input.args, "force");
  const path = resolve(input.cwd, configPath(input.args) ?? defaultConfigPath);

  if (!force && (await exists(path))) {
    throw new CliError(`Config already exists: ${path}`);
  }

  const overridePath = configPath(input.args);
  if (overridePath) {
    await writeDefaultProjectConfig({
      cwd: input.cwd,
      configPath: overridePath,
      harness,
    });
  } else {
    await writeDefaultProjectConfig({
      cwd: input.cwd,
      harness,
    });
  }
  await mkdir(resolve(input.cwd, ".oma", "sessions"), { recursive: true });
  await mkdir(resolve(input.cwd, ".oma", "runs"), { recursive: true });
  await mkdir(resolve(input.cwd, ".oma", "outcomes"), { recursive: true });

  if (jsonOutput(input.args)) {
    json(input.output, {
      configPath: path,
      harness,
    });
  } else {
    text(input.output, `initialized ${defaultConfigPath}`);
  }

  return 0;
}

async function commandDoctor(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; message: string }> = [];

  try {
    const config = await loadResolvedProject(input.args, input.cwd);
    checks.push({ name: "config", ok: true, message: config.configPath });
    checks.push({
      name: "workspace",
      ok: await exists(config.workspace),
      message: config.workspace,
    });

    const executable = executableFor(config.harness.kind, config.harness.options);
    if (executable) {
      const result = await commandVersion(executable);
      checks.push({
        name: "harness",
        ok: result.ok,
        message: result.message,
      });
    }
  } catch (error) {
    checks.push({ name: "config", ok: false, message: messageFrom(error) });
  }

  if (jsonOutput(input.args)) {
    json(input.output, {
      ok: checks.every((check) => check.ok),
      checks,
    });
  } else {
    for (const check of checks) {
      text(input.output, `${check.ok ? "ok" : "error"} ${check.name}: ${check.message}`);
    }
  }

  return checks.every((check) => check.ok) ? 0 : 1;
}

function executableFor(
  kind: HarnessKind,
  options: Record<string, unknown> | undefined,
): string | undefined {
  const configured = options?.executable;
  if (typeof configured === "string") {
    return configured;
  }

  switch (kind) {
    case "claude-code":
      return "claude";
    case "codex-cli":
      return "codex";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
    case "mock":
      return undefined;
  }
}

async function commandVersion(executable: string): Promise<{ ok: boolean; message: string }> {
  const { spawn } = await import("node:child_process");

  return await new Promise((resolveResult) => {
    const child = spawn(executable, ["--version"], {
      shell: false,
    });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`;
    });
    child.on("error", (error) => {
      resolveResult({ ok: false, message: error.message });
    });
    child.on("close", (exitCode) => {
      resolveResult({
        ok: exitCode === 0,
        message: output.trim() || `${executable} exited ${String(exitCode)}`,
      });
    });
  });
}

async function commandRun(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const goal = input.args.positionals.join(" ").trim();
  if (!goal) {
    throw new CliError("oma run requires objective text.");
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const store = createSessionStore(config);
  const session = await store.create();
  const outcome = await run({
    objective: objective({ goal }),
    process: {
      session,
      harness: createHarness(config),
    },
    environment: createEnvironment(config),
    validation: createValidators(config),
  });
  const record = await writeOutcomeFiles(config, outcome);

  if (jsonOutput(input.args)) {
    json(input.output, { ...record, eventCount: outcome.events.length });
  } else {
    text(input.output, `${outcome.runId} ${outcome.status}`);
  }

  return isSucceeded(outcome.status) ? 0 : 1;
}

async function commandInspect(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma inspect requires a run ID.");
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const record = await requireRunRecord(config, id);
  const outcomeJson = JSON.parse(
    await readFile(resolve(config.root, record.outcomeJsonPath), "utf8"),
  ) as Record<string, unknown>;

  if (jsonOutput(input.args)) {
    json(input.output, {
      ...record,
      outcome: outcomeJson,
    });
  } else {
    text(input.output, `${record.runId} ${record.status}`);
    text(input.output, `session ${record.sessionId}`);
    text(input.output, `artifacts ${String((outcomeJson.artifacts as unknown[])?.length ?? 0)}`);
    text(input.output, `validation ${String((outcomeJson.validation as unknown[])?.length ?? 0)}`);
    text(input.output, `outcome ${record.outcomeMarkdownPath}`);
  }

  return 0;
}

async function commandReplay(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma replay requires a run ID or session ID.");
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const session = await sessionForId(config, id);
  const projection = await replay(session);
  const replayed = await replayOutcome(session);

  if (jsonOutput(input.args)) {
    json(input.output, replayed.ok ? replayed.outcome : replayed);
  } else {
    text(input.output, `${projection.runId ?? session.id} ${projection.status}`);
    text(input.output, `events ${String(projection.events.length)}`);
    text(input.output, `diagnostics ${String(projection.diagnostics.length)}`);
  }

  return replayed.ok ? 0 : 1;
}

async function commandResume(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma resume requires a run ID or session ID.");
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const session = await sessionForId(config, id);
  const projection = await replay(session);
  const outcome = await resume({
    objective: projection.objective ?? objective({ goal: "Resume OMA run" }),
    process: {
      session,
      harness: createHarness(config),
    },
    environment: createEnvironment(config),
    validation: createValidators(config),
  });
  const record = await writeOutcomeFiles(config, outcome);

  if (jsonOutput(input.args)) {
    json(input.output, { ...record, eventCount: outcome.events.length });
  } else {
    text(input.output, `${outcome.runId} ${outcome.status}`);
  }

  return isSucceeded(outcome.status) ? 0 : 1;
}

async function commandValidate(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma validate requires a run ID.");
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const session = await sessionForId(config, id);
  const replayed = await replayOutcome(session);
  if (!replayed.ok) {
    throw new CliError(`Cannot validate non-terminal session: ${replayed.reason}`);
  }

  const validationSession = sessions.ephemeral();
  const environment = createEnvironment(config).bind({
    runId: replayed.outcome.runId,
    session: validationSession,
  });
  const validation = await validateArtifacts({
    objective: replayed.outcome.objective,
    artifacts: replayed.outcome.artifacts,
    environment,
    session: validationSession,
    validators: createValidators(config),
  });
  const report: ValidationReport = {
    schemaVersion: 1,
    runId: replayed.outcome.runId,
    status: statusFromValidation(validation),
    validation,
  };
  const path = await writeValidationReport(config, report);

  if (jsonOutput(input.args)) {
    json(input.output, report);
  } else {
    text(input.output, `${replayed.outcome.runId} ${report.status}`);
    text(input.output, `validation ${path}`);
  }

  return isSucceeded(report.status) ? 0 : 1;
}

async function commandRuns(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const api = apiBaseUrl(input.args);
  if (api) {
    const body = await apiJson<{ runs: Array<Record<string, unknown>> }>(api, "/runs");
    if (jsonOutput(input.args)) {
      json(input.output, body);
    } else if (body.runs.length === 0) {
      text(input.output, "No runs.");
    } else {
      for (const runRecord of body.runs) {
        text(
          input.output,
          `${String(runRecord.runId)} ${String(runRecord.status)} ${formatAge(String(runRecord.updatedAt))} ${preview(String((runRecord.objective as { goal?: string })?.goal ?? ""))}`,
        );
      }
    }
    return 0;
  }

  const config = await loadResolvedProject(input.args, input.cwd);
  const records = await listRunRecords(config);
  if (jsonOutput(input.args)) {
    json(input.output, { runs: records });
  } else if (records.length === 0) {
    text(input.output, "No runs.");
  } else {
    for (const record of records) {
      text(
        input.output,
        `${record.runId} ${record.status} ${formatAge(record.updatedAt)} ${preview(record.objective)}`,
      );
    }
  }
  return 0;
}

async function commandOutcome(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma outcome requires a run ID.");
  }

  const api = apiBaseUrl(input.args);
  if (api) {
    const outcomeJson = await apiJson<Record<string, unknown>>(api, `/runs/${id}/outcome`);
    if (jsonOutput(input.args)) {
      json(input.output, outcomeJson);
    } else {
      text(input.output, `${String(outcomeJson.runId)} ${String(outcomeJson.status)}`);
      text(input.output, preview(String((outcomeJson.objective as { goal?: string })?.goal ?? "")));
      text(input.output, `artifacts ${String((outcomeJson.artifacts as unknown[])?.length ?? 0)}`);
      text(
        input.output,
        `validation ${String((outcomeJson.validation as unknown[])?.length ?? 0)}`,
      );
      text(input.output, `events ${String(outcomeJson.eventCount ?? 0)}`);
    }
    return 0;
  }

  const outcomeValue = await localOutcome(await loadResolvedProject(input.args, input.cwd), id);
  if (jsonOutput(input.args)) {
    json(input.output, outcomes.toJson(outcomeValue));
  } else {
    text(input.output, `${outcomeValue.runId} ${outcomeValue.status}`);
    text(input.output, preview(outcomeValue.objective.goal));
    text(input.output, `artifacts ${String(outcomeValue.artifacts.length)}`);
    text(input.output, `validation ${String(outcomeValue.validation.length)}`);
    text(input.output, `events ${String(outcomeValue.events.length)}`);
  }
  return 0;
}

async function commandEvents(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma events requires a run ID.");
  }

  const typeFilter = flag(input.args, "type");
  const api = apiBaseUrl(input.args);
  const events = api
    ? (await apiJson<{ events: StoredEvent[] }>(api, `/runs/${id}/events`)).events
    : await localEvents(await loadResolvedProject(input.args, input.cwd), id);
  const filtered = typeFilter ? events.filter((event) => event.type === typeFilter) : events;

  if (jsonOutput(input.args)) {
    json(input.output, { events: filtered });
  } else if (filtered.length === 0) {
    text(input.output, "No events.");
  } else {
    for (const event of filtered) {
      text(input.output, eventLine(event));
    }
  }
  return 0;
}

async function commandArtifacts(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma artifacts requires a run ID.");
  }

  const api = apiBaseUrl(input.args);
  if (api) {
    const body = await apiJson<{ artifacts: Array<Record<string, unknown>> }>(
      api,
      `/runs/${id}/artifacts`,
    );
    if (jsonOutput(input.args)) {
      json(input.output, body);
    } else if (body.artifacts.length === 0) {
      text(input.output, "No artifacts.");
    } else {
      for (const artifact of body.artifacts) {
        text(
          input.output,
          `${String(artifact.id)} ${String(artifact.name)} ${String(artifact.kind)} ${String(artifact.mediaType)} ${String(artifact.size)}b`,
        );
      }
    }
    return 0;
  }

  const artifactsValue = (await localOutcome(await loadResolvedProject(input.args, input.cwd), id))
    .artifacts;
  if (jsonOutput(input.args)) {
    json(input.output, {
      artifacts: artifactsValue.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        name: artifact.name,
        size: artifactSize(artifact),
      })),
    });
  } else if (artifactsValue.length === 0) {
    text(input.output, "No artifacts.");
  } else {
    for (const artifact of artifactsValue) {
      text(
        input.output,
        `${artifact.id} ${artifact.name} ${artifact.kind} ${artifact.mediaType} ${String(artifactSize(artifact))}b`,
      );
    }
  }
  return 0;
}

async function commandArtifact(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const [id, selector] = input.args.positionals;
  if (!id || !selector) {
    throw new CliError("oma artifact requires a run ID and artifact ID or name.");
  }

  const outputPath = flag(input.args, "output");
  const api = apiBaseUrl(input.args);
  let content: string;

  if (api) {
    const artifactsBody = await apiJson<{ artifacts: Array<{ id: string; name: string }> }>(
      api,
      `/runs/${id}/artifacts`,
    );
    const artifact = artifactsBody.artifacts.find(
      (candidate) => candidate.id === selector || candidate.name === selector,
    );
    if (!artifact) {
      throw new CliError(`Artifact not found: ${selector}`);
    }
    content = (await apiText(api, `/runs/${id}/artifacts/${artifact.id}`)).content;
  } else {
    const artifact = findArtifact(
      (await localOutcome(await loadResolvedProject(input.args, input.cwd), id)).artifacts,
      selector,
    );
    if (!artifact) {
      throw new CliError(`Artifact not found: ${selector}`);
    }
    content = artifact.content;
  }

  if (outputPath) {
    await writeFile(resolve(input.cwd, outputPath), content);
    text(input.output, outputPath);
  } else {
    text(input.output, expanded(input.args) ? content : truncate(content));
  }
  return 0;
}

async function commandValidation(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma validation requires a run ID.");
  }

  const api = apiBaseUrl(input.args);
  const validation = api
    ? ((await apiJson<Record<string, unknown>>(api, `/runs/${id}/outcome`))
        .validation as ValidationResult[])
    : (await localOutcome(await loadResolvedProject(input.args, input.cwd), id)).validation;

  if (jsonOutput(input.args)) {
    json(input.output, { validation });
  } else {
    for (const line of validationLines(validation, expanded(input.args))) {
      text(input.output, line);
    }
  }
  return validation.some((result) => result.status === "failed") ? 1 : 0;
}

async function commandWatch(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  const id = input.args.positionals[0];
  if (!id) {
    throw new CliError("oma watch requires a run ID.");
  }

  const api = apiBaseUrl(input.args);
  if (api) {
    const response = await fetch(`${api}/runs/${id}/events/stream`);
    if (!response.ok || !response.body) {
      throw new CliError(`Unable to stream run events: HTTP ${String(response.status)}`);
    }
    const body = await response.text();
    for (const block of body.split("\n\n")) {
      const eventType = block
        .split("\n")
        .find((line) => line.startsWith("event: "))
        ?.slice("event: ".length);
      const data = block
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      if (!eventType || !data) {
        continue;
      }
      if (eventType === "oma.event") {
        text(input.output, eventLine(JSON.parse(data) as StoredEvent));
      } else if (eventType === "oma.done") {
        const status = (JSON.parse(data) as { status?: string }).status ?? "done";
        text(input.output, `done ${status}`);
      }
    }
    return 0;
  }

  const events = await localEvents(await loadResolvedProject(input.args, input.cwd), id);
  for (const event of events) {
    text(input.output, eventLine(event));
  }
  return 0;
}

async function dispatch(input: {
  args: ReturnType<typeof parseArgs>;
  cwd: string;
  output: Output;
}): Promise<number> {
  if (hasFlag(input.args, "help") || input.args.command === "help" || !input.args.command) {
    text(input.output, help);
    return 0;
  }

  if (hasFlag(input.args, "version") || input.args.command === "version") {
    text(input.output, version);
    return 0;
  }

  switch (input.args.command) {
    case "doctor":
      return await commandDoctor(input);
    case "artifact":
      return await commandArtifact(input);
    case "artifacts":
      return await commandArtifacts(input);
    case "events":
      return await commandEvents(input);
    case "init":
      return await commandInit(input);
    case "inspect":
      return await commandInspect(input);
    case "outcome":
      return await commandOutcome(input);
    case "replay":
      return await commandReplay(input);
    case "resume":
      return await commandResume(input);
    case "run":
      return await commandRun(input);
    case "runs":
      return await commandRuns(input);
    case "validate":
      return await commandValidate(input);
    case "validation":
      return await commandValidation(input);
    case "watch":
      return await commandWatch(input);
    default:
      throw new CliError(`Unknown command: ${input.args.command}`);
  }
}

export async function runCli(input: CliInput): Promise<CliResult> {
  const output: Output = {
    stderr: [],
    stdout: [],
  };

  try {
    const exitCode = await dispatch({
      args: parseArgs(input.argv),
      cwd: input.cwd,
      output,
    });
    return {
      exitCode,
      stdout: output.stdout.join("\n"),
      stderr: output.stderr.join("\n"),
    };
  } catch (error) {
    errorText(output, messageFrom(error));
    return {
      exitCode: error instanceof CliError ? error.exitCode : 1,
      stdout: output.stdout.join("\n"),
      stderr: output.stderr.join("\n"),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
  });

  if (result.stdout.length > 0) {
    console.log(result.stdout);
  }
  if (result.stderr.length > 0) {
    console.error(result.stderr);
  }
  process.exitCode = result.exitCode;
}
