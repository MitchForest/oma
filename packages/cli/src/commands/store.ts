import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SqliteSessionStore } from "@oma/adapter-session-sqlite";
import { sessionStoreCapabilities } from "@oma/core";
import { parseArgs } from "../args";
import {
  defaultConfig,
  defaultConfigForStore,
  fileExists,
  loadConfig,
  resolveSandboxPolicy
} from "../config";
import { printSandboxInspection } from "../print";
import { createSandbox, loadStoreBundle } from "../runtime";
import { installTemplate } from "./templates";

export async function initCommand(args: string[]): Promise<number | void> {
  const parsed = parseArgs(args, { values: ["store", "template"] });
  const storeKind = parsed.values.get("store") ?? defaultConfig.store.kind;
  const config = defaultConfigForStore(storeKind);
  const configPath = resolve(".oma/config.json");

  await mkdir(dirname(configPath), { recursive: true });

  if (!(await fileExists(configPath))) {
    await Bun.write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  if (config.store.kind === "sqlite") {
    const store = new SqliteSessionStore(resolve(config.store.path));
    store.close();
  }

  console.log(`initialized .oma`);

  const templateName = parsed.values.get("template");

  if (!templateName) {
    return;
  }

  const installed = await installTemplate(templateName);

  console.log(`installed ${installed.workflowPath}`);

  // The installed workflow must be valid out of the box — validate it the
  // same way `oma workflow validate` would and fail loudly if not.
  const { loadWorkflowDocument, formatWorkflowDiagnostics } = await import("@oma/workflows");
  const loaded = await loadWorkflowDocument(installed.workflowPath);
  const failed = loaded.diagnostics.some((diagnostic) => diagnostic.severity === "error");

  if (failed) {
    console.error(formatWorkflowDiagnostics(loaded.diagnostics));
    return 1;
  }

  console.log(`valid ${loaded.workflow?.name}`);

  if (installed.readme) {
    console.log(`\n${installed.readme.trim()}`);
  }
}

export async function configCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { values: ["config"] });
  const config = await loadConfig(parsed.values.get("config") ?? ".oma/config.json");

  console.log(JSON.stringify(config, null, 2));
}

export async function storeCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest, { flags: ["json"] });

  if (subcommand !== "capabilities" && subcommand !== "check") {
    throw new Error("Usage: oma store <capabilities|check> [--json]");
  }

  const bundle = await loadStoreBundle();
  const capabilities = sessionStoreCapabilities(bundle.store);
  const output = {
    store: bundle.config.store,
    capabilities
  };

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (subcommand === "check") {
    console.log(`store ${bundle.config.store.kind} ok`);
  }

  for (const [key, value] of Object.entries(capabilities)) {
    console.log(`${key.padEnd(22)} ${value}`);
  }
}

export async function sandboxCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const parsed = parseArgs(rest, { flags: ["json"], values: ["config"] });

  if (subcommand !== "inspect" && subcommand !== "check") {
    throw new Error("Usage: oma sandbox <inspect|check> [--json]");
  }

  const config = await loadConfig(parsed.values.get("config") ?? ".oma/config.json");
  const policy = resolveSandboxPolicy(config.sandbox);

  if (subcommand === "inspect") {
    printSandboxInspection({ policy }, parsed.flags.has("json"));
    return;
  }

  const sandbox = await createSandbox(policy);

  try {
    // Smoke-test with a command we know the contract for: `bun --version`
    // when unrestricted, otherwise the first allowed command with no
    // arguments (no assumption that `--help` exists). The exit code is
    // reported, not asserted.
    const command = policy.allowedCommands?.[0] ?? "bun";
    const result = await sandbox.exec({
      command,
      args: command === "bun" ? ["--version"] : [],
      timeoutMs: Math.min(policy.timeoutMs ?? 30_000, 5_000),
      outputLimitBytes: 4_000
    });

    printSandboxInspection(
      {
        policy,
        sandboxId: sandbox.id,
        check: {
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          stdout: result.stdout,
          stderr: result.stderr
        }
      },
      parsed.flags.has("json")
    );
  } finally {
    await sandbox.destroy();
  }
}
