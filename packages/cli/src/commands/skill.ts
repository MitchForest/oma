import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "../args";
import { resolveAssetDir } from "./templates";

const skillUsage = "Usage: oma skill install [--to <dir>]";

/**
 * Installs the OMA skill for coding agents (Claude Code and friends): a
 * SKILL.md that teaches an agent to scaffold, author, validate, and operate
 * workflows through this CLI. The agent is the front door; OMA is the
 * durable substrate behind it.
 */
export async function skillCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand !== "install") {
    throw new Error(skillUsage);
  }

  const parsed = parseArgs(rest, { values: ["to"] });
  const target = parsed.values.get("to") ?? ".claude/skills";
  const source = join(resolveAssetDir("skills"), "oma");

  if (!(await Bun.file(join(source, "SKILL.md")).exists())) {
    throw new Error(`OMA skill source not found at ${source}`);
  }

  const destination = join(target, "oma");

  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });

  console.log(`installed ${join(destination, "SKILL.md")}`);
  console.log(
    'Your coding agent can now be told "use oma to set up a bugbot" (or any automation).'
  );
}
