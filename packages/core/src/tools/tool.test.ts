import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, toJsonValue, toolParameters } from "./tool";

test("toolParameters derives JSON Schema from Zod", () => {
  const tool = defineTool({
    name: "read_file",
    schema: z.object({
      path: z.string(),
      maxBytes: z.number().int().positive().optional()
    }),
    handler: async () => ({})
  });

  expect(toolParameters(tool)).toEqual({
    type: "object",
    properties: {
      path: { type: "string" },
      maxBytes: { type: "number" }
    },
    required: ["path"],
    additionalProperties: false
  });
});

test("toolParameters prefers explicit JSON Schema parameters", () => {
  const parameters = {
    type: "object",
    properties: {
      query: { type: "string" }
    }
  };
  const tool = defineTool({
    name: "search",
    parameters,
    handler: async () => ({})
  });

  expect(toolParameters(tool)).toBe(parameters);
});

test("toJsonValue rejects non-JSON values and cycles", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  expect(toJsonValue({ ok: true, nested: [1, "two"] })).toEqual({
    ok: true,
    nested: [1, "two"]
  });
  expect(() => toJsonValue({ value: BigInt(1) }, "tool.result")).toThrow(
    "tool.result.value must be JSON-serializable"
  );
  expect(() => toJsonValue({ value: undefined }, "tool.result")).toThrow(
    "tool.result.value must be JSON-serializable"
  );
  expect(() => toJsonValue(cyclic, "tool.result")).toThrow(
    "tool.result.self must be JSON-serializable"
  );
});
