import { z } from "zod";
import type { WorkflowOutputSpec } from "./schema";

/** Builds the zod validator for a stage's declared output fields. */
export function outputSpecSchema(spec: WorkflowOutputSpec): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [field, type] of Object.entries(spec)) {
    shape[field] = fieldSchema(type);
  }

  return z.object(shape).strict();
}

/**
 * Prompt suffix instructing the model how to report the stage result. The
 * runner parses the last fenced json block of the final assistant message.
 */
export function outputInstruction(spec: WorkflowOutputSpec): string {
  const fields = Object.entries(spec)
    .map(([field, type]) => `  "${field}": ${describeField(type)}`)
    .join(",\n");

  return [
    "When you are completely done, end your final message with a fenced ```json code block",
    "containing exactly this object (no other fields, no commentary inside the block):",
    "```json",
    "{",
    fields,
    "}",
    "```"
  ].join("\n");
}

export interface ExtractedOutput {
  output?: Record<string, unknown>;
  error?: string;
}

/**
 * Pulls the stage output out of the assistant's final message: the last
 * fenced ```json block wins; a trailing bare JSON object is the fallback.
 */
export function extractStageOutput(text: string, spec: WorkflowOutputSpec): ExtractedOutput {
  const candidate = lastFencedJson(text) ?? trailingJsonObject(text);

  if (candidate === undefined) {
    return { error: "No json code block found in the final message." };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const validated = outputSpecSchema(spec).safeParse(parsed);

  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { error: `Output did not match the declared fields: ${issues}` };
  }

  return { output: validated.data };
}

function fieldSchema(type: string): z.ZodTypeAny {
  if (type === "string") {
    return z.string();
  }

  if (type === "number") {
    return z.number();
  }

  if (type === "boolean") {
    return z.boolean();
  }

  const values = enumValues(type);
  return z.enum(values as [string, ...string[]]);
}

function describeField(type: string): string {
  if (type === "string") {
    return '"<string>"';
  }

  if (type === "number") {
    return "<number>";
  }

  if (type === "boolean") {
    return "<true|false>";
  }

  return enumValues(type)
    .map((value) => `"${value}"`)
    .join(" or ");
}

export function enumValues(type: string): string[] {
  return type.split("|").map((value) => value.trim());
}

function lastFencedJson(text: string): string | undefined {
  const pattern = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | undefined;

  while ((match = pattern.exec(text)) !== null) {
    last = match[1];
  }

  return last?.trim() || undefined;
}

function trailingJsonObject(text: string): string | undefined {
  const trimmed = text.trim();

  if (!trimmed.endsWith("}")) {
    return undefined;
  }

  // Walk `{` candidates from the end so the innermost trailing object wins
  // over any `{` appearing earlier in prose.
  for (let start = trimmed.lastIndexOf("{"); start >= 0; start = trimmed.lastIndexOf("{", start - 1)) {
    const candidate = trimmed.slice(start);

    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // keep scanning backwards
    }
  }

  return undefined;
}
