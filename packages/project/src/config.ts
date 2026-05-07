import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProjectError } from "./errors";
import type {
  HarnessKind,
  OmaConfig,
  ResolvedProject,
  SessionConfig,
  ValidatorConfig,
} from "./types";

export const defaultConfigPath = "oma.config.json";

const harnessKinds = new Set<HarnessKind>(["claude-code", "codex-cli", "mock", "opencode", "pi"]);

export function isHarnessKind(value: string): value is HarnessKind {
  return harnessKinds.has(value as HarnessKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ProjectError(`Config field ${key} must be an array of strings.`);
  }
  return value;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectError(`Config field ${key} must be a number.`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ProjectError(`Config field ${key} must be a boolean.`);
  }
  return value;
}

function parseSession(value: unknown): SessionConfig {
  if (value === undefined) {
    return {
      kind: "jsonl",
      dir: ".oma/sessions",
    };
  }

  if (!isRecord(value)) {
    throw new ProjectError("Config field session must be an object.");
  }

  const kind = readString(value, "kind");
  if (kind === "jsonl") {
    const dir = readString(value, "dir");
    if (!dir) {
      throw new ProjectError("Config field session.dir is required for jsonl sessions.");
    }
    return { kind, dir };
  }

  if (kind === "sqlite") {
    const path = readString(value, "path");
    if (!path) {
      throw new ProjectError("Config field session.path is required for sqlite sessions.");
    }
    return { kind, path };
  }

  throw new ProjectError("Config field session.kind must be jsonl or sqlite.");
}

function parseValidator(value: unknown, index: number): ValidatorConfig {
  if (!isRecord(value)) {
    throw new ProjectError(`Config validation[${index}] must be an object.`);
  }

  const kind = readString(value, "kind");
  if (kind === "artifactExists") {
    const path = readString(value, "path");
    const paths = readStringArray(value, "paths");
    if (paths) {
      return { kind, paths };
    }
    if (path) {
      return { kind, path };
    }
    throw new ProjectError(`Config validation[${index}] requires path or paths.`);
  }

  if (kind === "command") {
    const command = readString(value, "command");
    if (!command) {
      throw new ProjectError(`Config validation[${index}].command is required.`);
    }
    const output: ValidatorConfig = { kind, command };
    const args = readStringArray(value, "args");
    const cwd = readString(value, "cwd");
    const id = readString(value, "id");
    const timeoutMs = readNumber(value, "timeoutMs");
    if (args) {
      output.args = args;
    }
    if (cwd) {
      output.cwd = cwd;
    }
    if (id) {
      output.id = id;
    }
    if (timeoutMs !== undefined) {
      output.timeoutMs = timeoutMs;
    }
    return output;
  }

  if (kind === "test" || kind === "typecheck" || kind === "lint") {
    const command = readString(value, "command");
    if (!command) {
      throw new ProjectError(`Config validation[${index}].command is required.`);
    }
    const output: ValidatorConfig = { kind, command };
    const args = readStringArray(value, "args");
    const cwd = readString(value, "cwd");
    const id = readString(value, "id");
    const timeoutMs = readNumber(value, "timeoutMs");
    if (args) {
      output.args = args;
    }
    if (cwd) {
      output.cwd = cwd;
    }
    if (id) {
      output.id = id;
    }
    if (timeoutMs !== undefined) {
      output.timeoutMs = timeoutMs;
    }
    return output;
  }

  if (kind === "gitDiff") {
    const output: ValidatorConfig = { kind };
    const id = readString(value, "id");
    const required = readBoolean(value, "required");
    const allowDirty = readBoolean(value, "allowDirty");
    const maxBytes = readNumber(value, "maxBytes");
    if (id) {
      output.id = id;
    }
    if (required !== undefined) {
      output.required = required;
    }
    if (allowDirty !== undefined) {
      output.allowDirty = allowDirty;
    }
    if (maxBytes !== undefined) {
      output.maxBytes = maxBytes;
    }
    return output;
  }

  if (kind === "schema") {
    const artifact = readString(value, "artifact");
    const schema = value.schema;
    if (!artifact) {
      throw new ProjectError(`Config validation[${index}].artifact is required.`);
    }
    if (!isRecord(schema)) {
      throw new ProjectError(`Config validation[${index}].schema must be an object.`);
    }
    const output: ValidatorConfig = { kind, artifact, schema };
    const id = readString(value, "id");
    if (id) {
      output.id = id;
    }
    return output;
  }

  if (kind === "all" || kind === "any" || kind === "sequence") {
    const id = readString(value, "id");
    const children = value.validators;
    if (!id) {
      throw new ProjectError(`Config validation[${index}].id is required.`);
    }
    if (!Array.isArray(children)) {
      throw new ProjectError(`Config validation[${index}].validators must be an array.`);
    }
    return {
      kind,
      id,
      validators: children.map((child, childIndex) =>
        parseValidator(child, Number(`${index}${childIndex}`)),
      ),
    };
  }

  throw new ProjectError(`Config validation[${index}].kind is not supported.`);
}

export function parseProjectConfig(value: unknown): OmaConfig {
  if (!isRecord(value)) {
    throw new ProjectError("Config must be a JSON object.");
  }

  if (value.schemaVersion !== 1) {
    throw new ProjectError("Config field schemaVersion must be 1.");
  }

  const workspace = readString(value, "workspace");
  if (!workspace) {
    throw new ProjectError("Config field workspace is required.");
  }

  const harnessValue = value.harness;
  if (!isRecord(harnessValue)) {
    throw new ProjectError("Config field harness is required.");
  }

  const harnessKind = readString(harnessValue, "kind");
  if (!harnessKind || !isHarnessKind(harnessKind)) {
    throw new ProjectError("Config field harness.kind is not supported.");
  }

  const options = harnessValue.options;
  if (options !== undefined && !isRecord(options)) {
    throw new ProjectError("Config field harness.options must be an object.");
  }

  const validationValue = value.validation;
  const validation =
    validationValue === undefined
      ? []
      : Array.isArray(validationValue)
        ? validationValue.map(parseValidator)
        : undefined;

  if (!validation) {
    throw new ProjectError("Config field validation must be an array.");
  }

  const config: OmaConfig = {
    schemaVersion: 1,
    workspace,
    harness: {
      kind: harnessKind,
    },
    session: parseSession(value.session),
    validation,
  };

  if (options) {
    config.harness.options = options;
  }

  return config;
}

export async function loadProject(input: {
  cwd: string;
  configPath?: string;
}): Promise<ResolvedProject> {
  const configPath = resolve(input.cwd, input.configPath ?? defaultConfigPath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ProjectError(`Config not found: ${configPath}`);
    }
    throw error;
  }

  const config = parseProjectConfig(parsed);
  const root = dirname(configPath);
  const stateDir = resolve(root, ".oma");

  return {
    configPath,
    root,
    stateDir,
    workspace: resolve(root, config.workspace),
    databasePath: resolve(stateDir, "server.sqlite"),
    harness: config.harness,
    session: config.session ?? {
      kind: "jsonl",
      dir: ".oma/sessions",
    },
    validation: config.validation ?? [],
  };
}

export function defaultProjectConfig(input: { harness: HarnessKind }): OmaConfig {
  return {
    schemaVersion: 1,
    workspace: ".",
    harness: {
      kind: input.harness,
    },
    session: {
      kind: "jsonl",
      dir: ".oma/sessions",
    },
    validation: [],
  };
}

export async function writeDefaultProjectConfig(input: {
  cwd: string;
  configPath?: string;
  harness: HarnessKind;
}): Promise<string> {
  const path = resolve(input.cwd, input.configPath ?? defaultConfigPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(defaultProjectConfig({ harness: input.harness }), null, 2)}\n`,
  );
  return path;
}
