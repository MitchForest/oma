import type { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchemaObject = Record<string, JsonValue | undefined>;

export interface ToolContext {
  sessionId: string;
  callId: string;
  idempotencyKey?: string;
}

export type ToolEffect = "read" | "write" | "external";

export interface Tool<TArgs = unknown, TResult = unknown> {
  name: string;
  description?: string;
  effect?: ToolEffect;
  capabilities?: string[];
  schema?: z.ZodType<TArgs>;
  parameters?: JsonSchemaObject;
  idempotencyKey?: (args: TArgs, context: ToolContext) => string;
  handler(args: TArgs, context: ToolContext): Promise<TResult> | TResult;
}

export type AnyTool = Tool<any, any>;
export type ToolRegistry = AnyTool[] | Map<string, AnyTool>;

export function defineTool<TArgs = unknown, TResult = unknown>(
  tool: Tool<TArgs, TResult>
): Tool<TArgs, TResult> {
  return tool;
}

export function indexTools(tools: ToolRegistry): Map<string, AnyTool> {
  if (tools instanceof Map) {
    return tools;
  }

  return new Map(tools.map((tool) => [tool.name, tool]));
}

export function toolParameters(tool: AnyTool): JsonSchemaObject {
  if (tool.parameters) {
    return tool.parameters;
  }

  if (tool.schema) {
    return zodToJsonSchema(tool.schema);
  }

  return emptyObjectSchema();
}

export function parseToolArgs(tool: AnyTool, input: unknown): unknown {
  return tool.schema ? tool.schema.parse(input) : input;
}

export function toJsonValue(value: unknown, label = "value"): JsonValue {
  return normalizeJsonValue(value, label, new WeakSet<object>());
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  const unwrapped = unwrap(schema);
  const typeName = unwrapped._def.typeName;

  if (typeName === "ZodObject") {
    const objectSchema = unwrapped as z.ZodObject<z.ZodRawShape>;
    const shape = objectSchema.shape;
    const properties: Record<string, JsonSchemaObject> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);

      if (!isOptional(value)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties: properties as unknown as JsonValue,
      required,
      additionalProperties: objectSchema._def.unknownKeys === "passthrough"
    };
  }

  if (typeName === "ZodString") {
    return withDescription(unwrapped, { type: "string" });
  }

  if (typeName === "ZodNumber") {
    return withDescription(unwrapped, { type: "number" });
  }

  if (typeName === "ZodBoolean") {
    return withDescription(unwrapped, { type: "boolean" });
  }

  if (typeName === "ZodArray") {
    const arraySchema = unwrapped as z.ZodArray<z.ZodTypeAny>;
    return withDescription(unwrapped, {
      type: "array",
      items: zodToJsonSchema(arraySchema.element) as JsonValue
    });
  }

  if (typeName === "ZodEnum") {
    const enumSchema = unwrapped as z.ZodEnum<[string, ...string[]]>;
    return withDescription(unwrapped, {
      type: "string",
      enum: enumSchema.options
    });
  }

  if (typeName === "ZodLiteral") {
    const literal = (unwrapped as z.ZodLiteral<unknown>)._def.value;

    if (!isJsonPrimitive(literal)) {
      return withDescription(unwrapped, {});
    }

    return withDescription(unwrapped, {
      type: literal === null ? "null" : typeof literal,
      const: literal
    });
  }

  return withDescription(unwrapped, {});
}

function emptyObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const typeName = schema._def.typeName;

  if (typeName === "ZodOptional" || typeName === "ZodNullable") {
    return unwrap(schema._def.innerType);
  }

  if (typeName === "ZodDefault") {
    return unwrap(schema._def.innerType);
  }

  return schema;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional() || schema._def.typeName === "ZodDefault";
}

function withDescription(
  schema: z.ZodTypeAny,
  value: JsonSchemaObject
): JsonSchemaObject {
  const description = schema.description;

  return description ? { ...value, description } : value;
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  seen: WeakSet<object>
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be JSON-serializable; received non-finite number`);
    }

    return value;
  }

  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`${label} must be JSON-serializable; received ${typeof value}`);
  }

  if (value === undefined) {
    throw new Error(`${label} must be JSON-serializable; received undefined`);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`${label} must be JSON-serializable; received circular reference`);
    }

    seen.add(value);
    const normalized = value.map((item, index) =>
      normalizeJsonValue(item, `${label}[${index}]`, seen)
    );
    seen.delete(value);
    return normalized;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new Error(`${label} must be JSON-serializable; received circular reference`);
    }

    seen.add(value);
    const normalized: JsonObject = {};

    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(item, `${label}.${key}`, seen);
    }

    seen.delete(value);
    return normalized;
  }

  throw new Error(`${label} must be JSON-serializable`);
}

function isJsonPrimitive(value: unknown): value is null | boolean | number | string {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
}
