import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  capText,
  defineTool,
  type AnyTool,
  type Sandbox,
  type SandboxPolicy,
  type SandboxProvider,
  type ToolContext
} from "@oma/core";
import { LocalSandboxProvider, resolveWithinRoot } from "@oma/adapter-sandbox-local";
import { z } from "zod";

export interface LocalToolsOptions {
  cwd?: string;
  testCommand?: string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  /**
   * Allowlist for model-chosen executables: it governs `bash` commands and
   * `run_tests` commands (the model can override the configured test command).
   * Harness-issued helpers (`git` for git_status/git_diff) are exempt — they
   * run fixed binaries with harness-built arguments. To restrict the sandbox
   * itself, set `sandboxPolicy.allowedCommands` (which then must include
   * `git`).
   */
  allowedCommands?: string[];
  env?: Record<string, string>;
  sandbox?: Sandbox;
  sandboxProvider?: SandboxProvider;
  sandboxPolicy?: SandboxPolicy;
}

const pathArgsSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().optional()
});

const writeFileSchema = pathArgsSchema.extend({
  content: z.string()
});

const replaceInFileSchema = pathArgsSchema.extend({
  old: z.string().min(1),
  new: z.string()
});

const listFilesSchema = z.object({
  pattern: z.string().optional(),
  maxResults: z.number().int().positive().max(10_000).default(200)
});

const searchSchema = z.object({
  query: z.string().min(1),
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(10_000).default(100),
  maxBytes: z.number().int().positive().optional()
});

const bashSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional()
});

const gitDiffSchema = z.object({
  cached: z.boolean().default(false),
  maxBytes: z.number().int().positive().optional()
});

const runTestsSchema = z.object({
  command: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional()
});

export function createLocalTools(options: LocalToolsOptions = {}): AnyTool[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultTimeoutMs = options.timeoutMs ?? 30_000;
  const outputLimitBytes = options.outputLimitBytes ?? 64_000;
  // `timeoutMs`/`outputLimitBytes`/`allowedCommands` are tool-level defaults
  // and are passed per request — they are deliberately not folded into the
  // sandbox policy, because sandbox policy acts as a hard cap and would
  // prevent internal calls (search) from using a larger output budget.
  const sandboxPolicy: SandboxPolicy = {
    kind: "local",
    env: options.env,
    ...options.sandboxPolicy,
    cwd
  };
  const sandboxProvider = options.sandboxProvider ?? new LocalSandboxProvider();
  let sandboxPromise: Promise<Sandbox> | undefined = options.sandbox
    ? Promise.resolve(options.sandbox)
    : undefined;
  const getSandbox = (context: ToolContext): Promise<Sandbox> => {
    if (!sandboxPromise) {
      sandboxPromise = sandboxProvider.provision(sandboxPolicy, {
        sessionId: context.sessionId
      });
    }

    return sandboxPromise;
  };

  return [
    defineTool({
      name: "read_file",
      description: "Read a file within the configured working directory.",
      effect: "read",
      capabilities: ["file.read"],
      schema: pathArgsSchema,
      handler: async ({ path, maxBytes }) => {
        const filePath = await resolveWithinRoot(cwd, path);
        const content = await readFile(filePath, "utf8");
        const limited = capText(content, maxBytes ?? outputLimitBytes);

        return {
          path: relative(cwd, filePath),
          content: limited.value,
          bytes: Buffer.byteLength(content),
          truncated: limited.truncated
        };
      }
    }),
    defineTool({
      name: "write_file",
      description: "Write a complete file within the configured working directory.",
      effect: "write",
      capabilities: ["file.write"],
      schema: writeFileSchema,
      handler: async ({ path, content }) => {
        const filePath = await resolveWithinRoot(cwd, path);

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content);

        return {
          path: relative(cwd, filePath),
          bytes: Buffer.byteLength(content),
          unchanged: false
        };
      }
    }),
    defineTool({
      name: "replace_in_file",
      description: "Replace exact text in a file within the configured working directory.",
      effect: "write",
      capabilities: ["file.write"],
      schema: replaceInFileSchema,
      handler: async ({ path, old, new: replacement }) => {
        const filePath = await resolveWithinRoot(cwd, path);
        const content = await readFile(filePath, "utf8");
        const first = content.indexOf(old);

        if (first === -1) {
          throw new Error(`Text not found in ${path}`);
        }

        if (content.indexOf(old, first + old.length) !== -1) {
          throw new Error(
            `Text matches more than once in ${path}; provide a larger unique snippet`
          );
        }

        // Replacement via callback so "$&"-style patterns in the new text
        // stay literal instead of being interpreted by String.replace.
        const next = content.replace(old, () => replacement);
        await writeFile(filePath, next);

        return {
          path: relative(cwd, filePath),
          replacements: 1,
          bytes: Buffer.byteLength(next)
        };
      }
    }),
    defineTool({
      name: "list_files",
      description: "List files in the configured working directory.",
      effect: "read",
      capabilities: ["file.list"],
      schema: listFilesSchema,
      handler: async ({ pattern, maxResults }) => {
        const files = await listFiles(cwd, pattern, maxResults ?? 200);
        return { files, count: files.length };
      }
    }),
    defineTool({
      name: "search",
      description: "Search text in files under the configured working directory.",
      effect: "read",
      capabilities: ["file.search"],
      schema: searchSchema,
      handler: async ({ query, path, maxResults }) => {
        const searchPath = path ? await resolveWithinRoot(cwd, path) : cwd;
        const matches = await searchText(cwd, searchPath, query, maxResults ?? 100);

        return { matches, count: matches.length };
      }
    }),
    defineTool({
      name: "bash",
      description: "Run a local command in the configured working directory.",
      effect: "external",
      capabilities: ["process.exec"],
      schema: bashSchema,
      handler: async ({ command, args, timeoutMs, maxBytes }, context) => {
        assertAllowed(command, options.allowedCommands);
        const sandbox = await getSandbox(context);
        return sandbox.exec({
          command,
          args: args ?? [],
          timeoutMs: timeoutMs ?? defaultTimeoutMs,
          outputLimitBytes: maxBytes ?? outputLimitBytes
        });
      }
    }),
    defineTool({
      name: "git_status",
      description: "Return git status porcelain output.",
      effect: "read",
      capabilities: ["git.status"],
      schema: z.object({}).default({}),
      handler: async (_args, context) => {
        const sandbox = await getSandbox(context);
        const result = await sandbox.exec({
          command: "git",
          args: ["status", "--short"],
          timeoutMs: defaultTimeoutMs,
          outputLimitBytes
        });
        return {
          ...result,
          entries: result.stdout.split("\n").filter(Boolean)
        };
      }
    }),
    defineTool({
      name: "git_diff",
      description: "Return git diff text.",
      effect: "read",
      capabilities: ["git.diff"],
      schema: gitDiffSchema,
      handler: async ({ cached, maxBytes }, context) => {
        const args = cached ? ["diff", "--cached"] : ["diff"];
        const sandbox = await getSandbox(context);
        return sandbox.exec({
          command: "git",
          args,
          timeoutMs: defaultTimeoutMs,
          outputLimitBytes: maxBytes ?? outputLimitBytes
        });
      }
    }),
    defineTool({
      name: "run_tests",
      description: "Run the configured test command.",
      effect: "external",
      capabilities: ["process.test"],
      schema: runTestsSchema,
      handler: async ({ command, timeoutMs, maxBytes }, context) => {
        const testCommand = command ?? options.testCommand ?? "bun test";
        const [executable, ...args] = parseCommandLine(testCommand);
        // The model can override the test command, so the executable counts
        // as model-chosen and goes through the allowlist.
        assertAllowed(executable, options.allowedCommands);
        const sandbox = await getSandbox(context);
        return sandbox.exec({
          command: executable,
          args,
          timeoutMs: timeoutMs ?? defaultTimeoutMs,
          outputLimitBytes: maxBytes ?? outputLimitBytes
        });
      }
    })
  ];
}

async function listFiles(
  cwd: string,
  pattern: string | undefined,
  maxResults: number
): Promise<string[]> {
  const files = await walk(cwd, cwd, Number.MAX_SAFE_INTEGER);
  return files.filter((file) => matchesGlob(file, pattern)).slice(0, maxResults);
}

async function walk(root: string, dir: string, maxResults: number): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const files: string[] = [];

  for (const entry of entries) {
    if (files.length >= maxResults || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const path = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(root, path, maxResults - files.length)));
      continue;
    }

    if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }

  return files;
}

async function searchText(
  root: string,
  path: string,
  query: string,
  maxResults: number
): Promise<Array<{ path: string; line: number; text: string }>> {
  const info = await stat(path);
  const files = info.isFile()
    ? [relative(root, path)]
    : await walk(root, path, Number.MAX_SAFE_INTEGER);
  const matches: Array<{ path: string; line: number; text: string }> = [];

  for (const file of files) {
    if (matches.length >= maxResults) {
      break;
    }

    let content: string;

    try {
      content = await readFile(resolve(root, file), "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= maxResults) {
        break;
      }

      const text = lines[index]!;

      if (text.includes(query)) {
        matches.push({ path: file, line: index + 1, text });
      }
    }
  }

  return matches;
}

function matchesGlob(path: string, pattern: string | undefined): boolean {
  if (!pattern) {
    return true;
  }

  const value = pattern.includes("/") ? path : path.split("/").at(-1)!;
  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function assertAllowed(command: string, allowedCommands: string[] | undefined): void {
  if (allowedCommands && !allowedCommands.includes(command)) {
    throw new Error(`Command is not allowed by local tools policy: ${command}`);
  }
}

function parseCommandLine(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.replace(/^["']|["']$/g, "")
  );

  if (!parts || parts.length === 0) {
    throw new Error("Test command must not be empty");
  }

  if (/[|&;<>()$`\\]/.test(command)) {
    throw new Error("run_tests does not execute shell syntax; use argv-style commands");
  }

  return parts;
}
