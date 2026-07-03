import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowDocument } from "@oma/workflows";
import { parseArgs } from "../args";

/**
 * Templates are installable product starts: a workflow, its profiles and
 * skills, and a README of next steps. Installing copies them into `.oma/`
 * (commit `.oma/workflows` and `.oma/profiles` — they are the reviewable
 * automation, not local state).
 */

export function templatesRoot(): string {
  return resolveAssetDir("templates");
}

/**
 * Bundled assets (templates, the skill, examples) live at the repo root in a
 * checkout and at the package root once published. Walk upward from this module
 * so both source files and the bundled dist/oma entry point find the same
 * package-local assets.
 */
export function resolveAssetDir(name: string): string {
  let current = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, name);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return fileURLToPath(new URL(`../../../../${name}`, import.meta.url));
}

export async function listTemplates(): Promise<string[]> {
  try {
    const entries = await readdir(templatesRoot(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function templatesCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { flags: ["json"] });
  const names = await listTemplates();
  const rows = [];

  for (const name of names) {
    const loaded = await loadWorkflowDocument(join(templatesRoot(), name, "workflow.yml"), {
      compileAgents: false
    });
    rows.push({
      name,
      title: loaded.workflow?.title ?? "",
      trigger: loaded.workflow?.trigger?.on ?? "manual"
    });
  }

  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("no templates found");
    return;
  }

  for (const row of rows) {
    console.log(`${row.name.padEnd(18)} ${row.trigger.padEnd(28)} ${row.title}`);
  }
}

export interface InstalledTemplate {
  workflowPath: string;
  readme?: string;
}

export async function installTemplate(name: string): Promise<InstalledTemplate> {
  const source = join(templatesRoot(), name);
  const workflowSource = join(source, "workflow.yml");

  if (!(await Bun.file(workflowSource).exists())) {
    const available = await listTemplates();
    throw new Error(
      `Unknown template "${name}". Available: ${available.join(", ") || "(none)"}`
    );
  }

  // A template is one workflow file — the whole product, ready to review.
  const workflowPath = join(".oma/workflows", `${name}.yml`);

  await mkdir(".oma/workflows", { recursive: true });
  await cp(workflowSource, workflowPath);

  const result: InstalledTemplate = { workflowPath };

  try {
    result.readme = await Bun.file(join(source, "README.md")).text();
  } catch {
    // template has no README
  }

  return result;
}
