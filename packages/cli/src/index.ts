#!/usr/bin/env bun
import { printHelp } from "./print";
import { closeOpenBundles } from "./runtime";
import { serveCommand, uiCommand } from "./commands/serve";
import {
  forkCommand,
  listCommand,
  runCommand,
  sendCommand,
  showCommand,
  tailCommand,
  wakeCommand
} from "./commands/sessions";
import {
  configCommand,
  initCommand,
  sandboxCommand,
  storeCommand
} from "./commands/store";
import { triggerCommand } from "./commands/triggers";
import { approvalCommand, workflowCommand } from "./commands/workflows";
import { workerCommand } from "./commands/worker";
import { templatesCommand } from "./commands/templates";
import { skillCommand } from "./commands/skill";

if (import.meta.main) {
  installSignalHandlers();
  process.exitCode = await runCli(Bun.argv.slice(2));
}

/**
 * Runs the CLI and returns its exit code instead of exiting the process, so
 * error paths are testable in-process and cleanup always runs.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...args] = argv;

  try {
    return (await main(command, args)) ?? 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await closeOpenBundles();
  }
}

function installSignalHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // Close MCP children, sandboxes (containers, worktrees), and stores
      // before exiting. 130 is the conventional interrupted exit code.
      void closeOpenBundles()
        .catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          process.exit(130);
        });
    });
  }
}

async function main(commandName: string | undefined, args: string[]): Promise<number | void> {
  if (!commandName || commandName === "help" || commandName === "--help") {
    printHelp();
    return;
  }

  if (commandName === "init") {
    return initCommand(args);
  }

  if (commandName === "run") {
    return runCommand(args);
  }

  if (commandName === "wake") {
    return wakeCommand(args);
  }

  if (commandName === "send") {
    return sendCommand(args);
  }

  if (commandName === "config") {
    return configCommand(args);
  }

  if (commandName === "store") {
    return storeCommand(args);
  }

  if (commandName === "sandbox") {
    return sandboxCommand(args);
  }

  if (commandName === "tail") {
    return tailCommand(args);
  }

  if (commandName === "workflow") {
    return workflowCommand(args);
  }

  if (commandName === "worker") {
    return workerCommand(args);
  }

  if (commandName === "templates") {
    return templatesCommand(args);
  }

  if (commandName === "skill") {
    return skillCommand(args);
  }

  if (commandName === "approve") {
    return approvalCommand(args, "granted");
  }

  if (commandName === "deny") {
    return approvalCommand(args, "denied");
  }

  if (commandName === "trigger") {
    return triggerCommand(args);
  }

  if (commandName === "serve") {
    return serveCommand(args);
  }

  if (commandName === "ui") {
    return uiCommand(args);
  }

  if (commandName === "show" || commandName === "events") {
    return showCommand(args, commandName === "events");
  }

  if (commandName === "list") {
    return listCommand(args);
  }

  if (commandName === "fork") {
    return forkCommand(args);
  }

  console.error(`Unknown command: ${commandName}`);
  printHelp();
  return 1;
}
