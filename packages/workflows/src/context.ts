import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { WorkflowContext } from "./schema";
import { parseTokenCount } from "./units";

/**
 * Context packs: the declarative answer to "what was the model shown, and
 * why did it fit?" Selection is glob-driven and sorted, every file carries a
 * content hash, token costs use a chars/4 estimate (an estimate — not a
 * provider tokenizer), and fitting a hard budget is deterministic: full
 * bodies demote to signature-level codemaps largest-first, then files drop
 * largest-first. Every decision lands in the `context.pack.built` event.
 */

export interface ContextPackFile {
  path: string;
  hash: string;
  mode: "full" | "map";
  tokens: number;
  demoted?: boolean;
  content: string;
}

export interface ContextPackDrop {
  path: string;
  tokens: number;
  reason: string;
}

export interface ContextPack {
  packId: string;
  files: ContextPackFile[];
  dropped: ContextPackDrop[];
  totalTokens: number;
  budget?: number;
}

export interface BuildContextPackOptions {
  cwd?: string;
}

export async function buildContextPack(
  context: WorkflowContext,
  options: BuildContextPackOptions = {}
): Promise<ContextPack> {
  const cwd = options.cwd ?? process.cwd();
  const budget = context.budget !== undefined ? parseTokenCount(context.budget) : undefined;
  const paths = await selectFiles(context, cwd);
  const dropped: ContextPackDrop[] = [];
  let files: ContextPackFile[] = [];

  for (const path of paths) {
    const text = await readTextFile(join(cwd, path));

    if (text === undefined) {
      dropped.push({ path, tokens: 0, reason: "unreadable or binary" });
      continue;
    }

    const mode = matchesAny(context.map, path) ? "map" : "full";
    files.push(makeEntry(path, text, mode));
  }

  if (budget !== undefined) {
    // Demote the largest full-body files to codemaps until the pack fits.
    let total = sumTokens(files);
    const demotable = [...files]
      .filter((file) => file.mode === "full")
      .sort(bySizeDescThenPath);

    for (const file of demotable) {
      if (total <= budget) {
        break;
      }

      const remapped = makeEntry(file.path, file.content, "map", { fromFull: true });
      total = total - file.tokens + remapped.tokens;
      files = files.map((entry) => (entry.path === file.path ? { ...remapped, demoted: true } : entry));
    }

    // Still over: drop the largest files outright, recorded with the reason.
    while (sumTokens(files) > budget && files.length > 0) {
      const victim = [...files].sort(bySizeDescThenPath)[0]!;

      files = files.filter((entry) => entry.path !== victim.path);
      dropped.push({
        path: victim.path,
        tokens: victim.tokens,
        reason: `over budget (${victim.tokens} tokens as ${victim.mode})`
      });
    }
  }

  // Restore path order after fitting so rendering stays deterministic.
  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    // Deterministic id: the same selection with the same contents is the
    // same pack, which is exactly what replay wants.
    packId: createHash("sha256")
      .update(files.map((file) => `${file.path}:${file.hash}:${file.mode}`).join("\n"))
      .digest("hex")
      .slice(0, 16),
    files,
    dropped,
    totalTokens: sumTokens(files),
    budget
  };
}

/** The section prepended to the prompt — the durable record of what the model saw. */
export function renderContextSection(pack: ContextPack): string {
  const rendered = pack.files
    .map(
      (file) =>
        `<file path="${file.path}" mode="${file.mode}" hash="${file.hash.slice(0, 12)}">\n${file.content}\n</file>`
    )
    .join("\n");

  return `<context>\n${rendered}\n</context>`;
}

/** The `context.pack.built` event payload for this pack. */
export function contextPackEvent(pack: ContextPack): {
  type: "context.pack.built";
  packId: string;
  files: Array<{ path: string; hash: string; mode: "full" | "map"; tokens: number; demoted?: boolean }>;
  dropped?: Array<{ path: string; tokens: number; reason: string }>;
  totalTokens: number;
  budget?: number;
} {
  return {
    type: "context.pack.built",
    packId: pack.packId,
    files: pack.files.map(({ path, hash, mode, tokens, demoted }) => ({
      path,
      hash,
      mode,
      tokens,
      ...(demoted ? { demoted } : {})
    })),
    dropped: pack.dropped.length > 0 ? pack.dropped : undefined,
    totalTokens: pack.totalTokens,
    budget: pack.budget
  };
}

export interface StaleContextFile {
  path: string;
  reason: "changed" | "missing";
}

/**
 * Freshness: recorded hashes are observations, not truth. Recomputes each
 * file's hash against the working tree and reports drift.
 */
export async function findStaleContextFiles(
  files: Array<{ path: string; hash: string }>,
  cwd = process.cwd()
): Promise<StaleContextFile[]> {
  const stale: StaleContextFile[] = [];

  for (const file of files) {
    const text = await readTextFile(join(cwd, file.path));

    if (text === undefined) {
      stale.push({ path: file.path, reason: "missing" });
    } else if (sha256(text) !== file.hash) {
      stale.push({ path: file.path, reason: "changed" });
    }
  }

  return stale;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function selectFiles(context: WorkflowContext, cwd: string): Promise<string[]> {
  const selected = new Set<string>();

  for (const pattern of context.include) {
    const glob = new Bun.Glob(pattern);

    for await (const match of glob.scan({ cwd, onlyFiles: true, dot: false })) {
      const path = relative(".", match);

      if (!matchesAny(context.exclude, path)) {
        selected.add(path);
      }
    }
  }

  return [...selected].sort((left, right) => left.localeCompare(right));
}

function matchesAny(patterns: string[], path: string): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

function makeEntry(
  path: string,
  text: string,
  mode: "full" | "map",
  options: { fromFull?: boolean } = {}
): ContextPackFile {
  const content = mode === "map" ? codemap(path, text) : text;

  return {
    path,
    // The hash is always of the full file, whatever mode is rendered: it is
    // the freshness anchor, not a rendering detail.
    hash: sha256(text),
    mode,
    tokens: estimateTokens(content),
    content,
    ...(options.fromFull ? {} : {})
  };
}

function sumTokens(files: ContextPackFile[]): number {
  return files.reduce((total, file) => total + file.tokens, 0);
}

function bySizeDescThenPath(left: ContextPackFile, right: ContextPackFile): number {
  return right.tokens - left.tokens || left.path.localeCompare(right.path);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    const text = await Bun.file(path).text();
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

// Top-level declarations only (column zero): indented const/let/function are
// implementation, not API surface.
const declarationPattern =
  /^(export\s+(default\s+)?)?(declare\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum|namespace)\b/;
const methodPattern = /^\s{2,6}(public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+)*[\w$]+\s*(<[^>]*>)?\([^;]*$/;
const headingPattern = /^#{1,6}\s/;

const codeExtensions = new Set(["ts", "tsx", "js", "jsx", "mjs", "cts", "mts"]);

/**
 * Signature-level codemap. A heuristic line scanner, not a parser: good
 * enough to show a file's API surface at ~5-10% of its body cost. Real
 * grammar-backed extraction can replace this without changing the format.
 */
export function codemap(path: string, text: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const lines = text.split("\n");

  if (codeExtensions.has(extension)) {
    const signatures = lines
      .filter((line) => declarationPattern.test(line) || methodPattern.test(line))
      .map((line) => {
        const braceIndex = line.indexOf("{");
        const trimmed = braceIndex >= 0 ? `${line.slice(0, braceIndex).trimEnd()} { … }` : line.trimEnd();
        return trimmed;
      });

    if (signatures.length > 0) {
      return `// codemap (signatures only)\n${signatures.join("\n")}`;
    }
  }

  if (extension === "md" || extension === "markdown") {
    const headings = lines.filter((line) => headingPattern.test(line));

    if (headings.length > 0) {
      return `<!-- codemap (headings only) -->\n${headings.join("\n")}`;
    }
  }

  const head = lines.slice(0, 12).join("\n");
  const remaining = Math.max(0, lines.length - 12);
  return remaining > 0 ? `${head}\n… (${remaining} more lines)` : head;
}
