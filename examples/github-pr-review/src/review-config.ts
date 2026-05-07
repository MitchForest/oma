import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  RepositoryInstruction,
  ReviewConfig,
  ReviewConfidence,
  ReviewPolicy,
  ReviewRisk,
} from "./types";

const riskValues = new Set<ReviewRisk>(["high", "medium", "low"]);
const confidenceValues = new Set<ReviewConfidence>(["high", "medium", "low"]);

export const defaultReviewConfig: ReviewConfig = {
  maxInlineComments: 10,
  inlineRisk: ["high"],
  inlineConfidence: ["high", "medium"],
  excludePaths: ["dist/**", "bun.lock", "package-lock.json"],
  instructionFiles: [".oma/pr-review.md", "AGENTS.md", "CLAUDE.md", ".cursor/BUGBOT.md"],
  maxInstructionBytes: 24_000,
};

export const defaultReviewPolicy: ReviewPolicy = {
  maxInlineComments: defaultReviewConfig.maxInlineComments,
  inlineRisk: [...defaultReviewConfig.inlineRisk],
  inlineConfidence: [...defaultReviewConfig.inlineConfidence],
  excludePaths: [...defaultReviewConfig.excludePaths],
};

function defaultConfig(): ReviewConfig {
  return {
    maxInlineComments: defaultReviewConfig.maxInlineComments,
    inlineRisk: [...defaultReviewConfig.inlineRisk],
    inlineConfidence: [...defaultReviewConfig.inlineConfidence],
    excludePaths: [...defaultReviewConfig.excludePaths],
    instructionFiles: [...defaultReviewConfig.instructionFiles],
    maxInstructionBytes: defaultReviewConfig.maxInstructionBytes,
  };
}

function readStringArray(input: { value: unknown; field: string }): string[] | undefined {
  if (input.value === undefined) {
    return undefined;
  }
  if (!Array.isArray(input.value) || !input.value.every((item) => typeof item === "string")) {
    throw new Error(`review config field ${input.field} must be an array of strings.`);
  }
  return input.value;
}

function readPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`review config field ${field} must be a non-negative integer.`);
  }
  return value;
}

function readRiskArray(value: unknown, field: string): ReviewRisk[] | undefined {
  const values = readStringArray({ value, field });
  if (!values) {
    return undefined;
  }
  for (const item of values) {
    if (!riskValues.has(item as ReviewRisk)) {
      throw new Error(`review config field ${field} contains unsupported risk: ${item}`);
    }
  }
  return values as ReviewRisk[];
}

function readConfidenceArray(value: unknown, field: string): ReviewConfidence[] | undefined {
  const values = readStringArray({ value, field });
  if (!values) {
    return undefined;
  }
  for (const item of values) {
    if (!confidenceValues.has(item as ReviewConfidence)) {
      throw new Error(`review config field ${field} contains unsupported confidence: ${item}`);
    }
  }
  return values as ReviewConfidence[];
}

function assertObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("review config must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function resolveConfigPath(root: string, configPath: string): string {
  return isAbsolute(configPath) ? configPath : resolve(root, configPath);
}

export async function loadReviewConfig(input: {
  root: string;
  configPath?: string | undefined;
}): Promise<ReviewConfig> {
  const hasExplicitConfigPath = input.configPath !== undefined;
  const path = resolveConfigPath(input.root, input.configPath ?? "review.config.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (hasExplicitConfigPath) {
        throw new Error(`explicit review config was not found: ${input.configPath}`);
      }
      return defaultConfig();
    }
    throw error;
  }

  const object = assertObject(JSON.parse(raw) as unknown);
  const maxInlineComments = readPositiveInteger(object.maxInlineComments, "maxInlineComments");
  const inlineRisk = readRiskArray(object.inlineRisk, "inlineRisk");
  const inlineConfidence = readConfidenceArray(object.inlineConfidence, "inlineConfidence");
  const excludePaths = readStringArray({
    value: object.excludePaths,
    field: "excludePaths",
  });
  const instructionFiles = readStringArray({
    value: object.instructionFiles,
    field: "instructionFiles",
  });
  const maxInstructionBytes = readPositiveInteger(
    object.maxInstructionBytes,
    "maxInstructionBytes",
  );

  return {
    maxInlineComments: maxInlineComments ?? defaultReviewConfig.maxInlineComments,
    inlineRisk: inlineRisk ?? [...defaultReviewConfig.inlineRisk],
    inlineConfidence: inlineConfidence ?? [...defaultReviewConfig.inlineConfidence],
    excludePaths: excludePaths ?? [...defaultReviewConfig.excludePaths],
    instructionFiles: instructionFiles ?? [...defaultReviewConfig.instructionFiles],
    maxInstructionBytes: maxInstructionBytes ?? defaultReviewConfig.maxInstructionBytes,
  };
}

function safeInstructionPath(path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`review instruction path must be repository-relative: ${path}`);
  }
  if (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.startsWith(".git/") ||
    (path.startsWith(".oma/") && path !== ".oma/pr-review.md") ||
    path.startsWith("node_modules/")
  ) {
    throw new Error(`review instruction path is sensitive and cannot be loaded: ${path}`);
  }
  return path;
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

async function readTextFileCapped(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const content = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return bytesRead > maxBytes ? `${content}\n... truncated` : content;
  } finally {
    await handle.close();
  }
}

export async function loadRepositoryInstructions(input: {
  workspace: string;
  files: string[];
  maxBytes?: number;
}): Promise<RepositoryInstruction[]> {
  const instructions: RepositoryInstruction[] = [];
  const maxBytes = input.maxBytes ?? defaultReviewConfig.maxInstructionBytes;
  const workspaceReal = await realpath(input.workspace);
  for (const file of input.files) {
    const safePath = safeInstructionPath(file);
    const resolved = resolve(input.workspace, safePath);
    if (!isInside(input.workspace, resolved)) {
      throw new Error(`review instruction path escapes repository: ${safePath}`);
    }
    try {
      const stat = await lstat(resolved);
      if (stat.isSymbolicLink()) {
        throw new Error(`review instruction path must not be a symlink: ${safePath}`);
      }
      const real = await realpath(resolved);
      if (!isInside(workspaceReal, real)) {
        throw new Error(`review instruction path escapes repository: ${safePath}`);
      }
      instructions.push({
        path: safePath,
        content: await readTextFileCapped(resolved, maxBytes),
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return instructions;
}
