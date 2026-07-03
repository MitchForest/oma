import { resolve } from "node:path";
import type { Profile, SandboxPolicy } from "@oma/core";

export interface RuntimeConfig {
  store:
    | {
        kind: "memory";
      }
    | {
        kind: "sqlite";
        path: string;
      }
    | {
        kind: "postgres";
        connectionString?: string;
        connectionStringEnv?: string;
        pollMs?: number;
      };
  model:
    | {
        kind: "fake";
      }
    | {
        kind: "openai-compatible";
        model: string;
        baseUrl?: string;
        apiKeyEnv?: string;
        temperature?: number;
        maxOutputTokens?: number;
      }
    | {
        kind: "anthropic";
        model: string;
        baseUrl?: string;
        apiKeyEnv?: string;
        temperature?: number;
        maxOutputTokens?: number;
      };
  sandbox: SandboxPolicy;
  tools?: {
    testCommand?: string;
    timeoutMs?: number;
    outputLimitBytes?: number;
    allowedCommands?: string[];
    env?: Record<string, string>;
    github?: {
      /** Env var holding the API token (default GITHUB_TOKEN). */
      tokenEnv?: string;
      baseUrl?: string;
    };
    mcp?: {
      servers: Array<{
        name: string;
        command: string;
        args?: string[];
        env?: Record<string, string>;
        namespaceTools?: boolean;
      }>;
    };
  };
}

export const defaultConfig: RuntimeConfig = {
  store: {
    kind: "sqlite",
    path: ".oma/sessions.sqlite"
  },
  model: {
    kind: "fake"
  },
  sandbox: {
    kind: "local",
    cwd: "."
  },
  tools: {
    testCommand: "bun test",
    timeoutMs: 30_000,
    // Present by default so profiles that declare GitHub tools validate out
    // of the box; the token is only required when a session actually runs.
    github: {
      tokenEnv: "GITHUB_TOKEN"
    }
  }
};

export async function loadConfig(path: string): Promise<RuntimeConfig> {
  if (!(await fileExists(path))) {
    return defaultConfig;
  }

  let config: Record<string, unknown>;

  try {
    config = await Bun.file(path).json();
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const store = normalizeStoreConfig(config.store ?? defaultConfig.store);
    const model = normalizeModelConfig(config.model);
    const sandbox = normalizeSandboxConfig(config.sandbox ?? defaultConfig.sandbox);

    if (store.kind === "postgres" && store.connectionString) {
      console.error(
        `warning: ${path} sets store.connectionString inline; prefer store.connectionStringEnv so credentials stay out of the config file`
      );
    }

    return {
      ...defaultConfig,
      ...config,
      store,
      model,
      sandbox,
      tools: { ...defaultConfig.tools, ...(config.tools as RuntimeConfig["tools"]) }
    };
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function defaultConfigForStore(kind: string): RuntimeConfig {
  if (kind === "memory") {
    return {
      ...defaultConfig,
      store: { kind: "memory" }
    };
  }

  if (kind === "sqlite") {
    return defaultConfig;
  }

  if (kind === "postgres") {
    return {
      ...defaultConfig,
      store: {
        kind: "postgres",
        connectionStringEnv: "DATABASE_URL"
      }
    };
  }

  throw new Error(`Unsupported store kind: ${kind}`);
}

function normalizeStoreConfig(config: unknown): RuntimeConfig["store"] {
  if (!config || typeof config !== "object") {
    return defaultConfig.store;
  }

  const store = config as Partial<RuntimeConfig["store"]>;

  if (store.kind === "memory") {
    return { kind: "memory" };
  }

  if (store.kind === "sqlite") {
    return {
      kind: "sqlite",
      path:
        typeof (store as { path?: unknown }).path === "string"
          ? (store as { path: string }).path
          : defaultConfig.store.kind === "sqlite"
            ? defaultConfig.store.path
            : ".oma/sessions.sqlite"
    };
  }

  if (store.kind === "postgres") {
    const postgresStore = store as {
      connectionString?: unknown;
      connectionStringEnv?: unknown;
      pollMs?: unknown;
    };

    return {
      kind: "postgres",
      connectionString:
        typeof postgresStore.connectionString === "string"
          ? postgresStore.connectionString
          : undefined,
      connectionStringEnv:
        typeof postgresStore.connectionStringEnv === "string"
          ? postgresStore.connectionStringEnv
          : "DATABASE_URL",
      pollMs:
        typeof postgresStore.pollMs === "number" ? postgresStore.pollMs : undefined
    };
  }

  throw new Error(`Unsupported store kind: ${String(store.kind)}`);
}

function normalizeModelConfig(config: unknown): RuntimeConfig["model"] {
  if (config === undefined || config === null) {
    // Missing model key falls back to the default, like store/sandbox/tools.
    return defaultConfig.model;
  }

  if (typeof config !== "object") {
    throw new Error("model must be an object");
  }

  const model = config as Partial<RuntimeConfig["model"]>;

  if (
    model.kind !== "fake" &&
    model.kind !== "openai-compatible" &&
    model.kind !== "anthropic"
  ) {
    throw new Error(`Unsupported model kind: ${String(model.kind)}`);
  }

  return { ...defaultConfig.model, ...model } as RuntimeConfig["model"];
}

function normalizeSandboxConfig(config: unknown): SandboxPolicy {
  if (!config || typeof config !== "object") {
    return defaultConfig.sandbox;
  }

  const sandbox = config as Partial<SandboxPolicy>;

  if (
    sandbox.kind !== "local" &&
    sandbox.kind !== "worktree" &&
    sandbox.kind !== "docker"
  ) {
    throw new Error(`Unsupported sandbox kind: ${String(sandbox.kind)}`);
  }

  return {
    ...defaultConfig.sandbox,
    ...sandbox,
    kind: sandbox.kind
  };
}

export function bundleSandboxPolicy(config: RuntimeConfig): SandboxPolicy {
  return resolveSandboxPolicy(config.sandbox);
}

export function profileSandboxPolicy(profile: Profile, config: RuntimeConfig): SandboxPolicy {
  return resolveSandboxPolicy({
    ...config.sandbox,
    ...profile.sandboxPolicy
  });
}

export function resolveSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  return {
    ...policy,
    cwd: typeof policy.cwd === "string" ? resolve(policy.cwd) : policy.cwd,
    repo: typeof policy.repo === "string" ? resolve(policy.repo) : policy.repo,
    root: typeof policy.root === "string" ? resolve(policy.root) : policy.root,
    mount: typeof policy.mount === "string" ? resolve(policy.mount) : policy.mount
  };
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
