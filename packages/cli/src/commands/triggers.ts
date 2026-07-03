import { parseArgs, numberFlag, parsePayloadFlag } from "../args";
import { printTriggerRouteOutput } from "../print";
import { loadRuntime, resolveWorkflowTarget, routeWorkflowSignal } from "../runtime";

export async function triggerCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const usage =
    "Usage: oma trigger emit <workflow.yml|name> <source> <kind> --payload <json|@file> [--json] [--no-wake]";

  if (subcommand !== "emit") {
    throw new Error(usage);
  }

  const parsed = parseArgs(rest, { flags: ["json", "no-wake"], values: ["payload", "max-steps"] });
  const [targetPath, source, kind] = parsed.positionals;

  if (!targetPath || !source || !kind) {
    throw new Error(usage);
  }

  const workflowPath = await resolveWorkflowTarget(targetPath);

  if (!workflowPath) {
    throw new Error(`No workflow named "${targetPath}" in .oma/workflows. ${usage}`);
  }

  const payload = await parsePayloadFlag(parsed.values.get("payload") ?? "{}");
  const bundle = await loadRuntime();
  const output = await routeWorkflowSignal(
    bundle,
    workflowPath,
    {
      source,
      kind,
      payload,
      receivedAt: new Date().toISOString()
    },
    {
      maxSteps: numberFlag(parsed, "max-steps", { integer: true, min: 1 }),
      noWake: parsed.flags.has("no-wake")
    }
  );

  printTriggerRouteOutput(output, parsed.flags.has("json"));
}
