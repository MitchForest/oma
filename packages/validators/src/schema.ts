import type { ValidationResult, Validator } from "@oma/runtime";
import { textEvidence } from "./evidence";

export type JsonSchema =
  | { type: "string"; enum?: string[] }
  | { type: "number"; enum?: number[] }
  | { type: "boolean" }
  | {
      type: "array";
      items?: JsonSchema;
    }
  | {
      type: "object";
      required?: string[];
      properties?: Record<string, JsonSchema>;
    };

export type SchemaValidatorInput = {
  id?: string;
  artifact: string;
  schema: JsonSchema;
};

function validateValue(value: unknown, schema: JsonSchema, path: string): string[] {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return [`${path} must be string.`];
      }
      return schema.enum && !schema.enum.includes(value)
        ? [`${path} must be one of ${schema.enum.join(", ")}.`]
        : [];
    case "number":
      if (typeof value !== "number") {
        return [`${path} must be number.`];
      }
      return schema.enum && !schema.enum.includes(value)
        ? [`${path} must be one of ${schema.enum.join(", ")}.`]
        : [];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be boolean.`];
    case "array":
      if (!Array.isArray(value)) {
        return [`${path} must be array.`];
      }
      return schema.items
        ? value.flatMap((item, index) =>
            validateValue(item, schema.items as JsonSchema, `${path}[${String(index)}]`),
          )
        : [];
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path} must be object.`];
      }
      const record = value as Record<string, unknown>;
      const required = schema.required ?? [];
      const missing = required
        .filter((key) => !(key in record))
        .map((key) => `${path}.${key} is required.`);
      const propertyErrors = Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
        key in record ? validateValue(record[key], child, `${path}.${key}`) : [],
      );
      return [...missing, ...propertyErrors];
    }
  }
}

export function schemaValidator(input: SchemaValidatorInput): Validator {
  return {
    id: input.id ?? `schema:${input.artifact}`,

    async validate({ artifacts }): Promise<ValidationResult> {
      const artifact = artifacts.find((candidate) => candidate.name === input.artifact);
      if (!artifact) {
        return {
          validatorId: this.id,
          status: "failed",
          evidence: [textEvidence(`Missing JSON artifact: ${input.artifact}`)],
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(artifact.content) as unknown;
      } catch {
        return {
          validatorId: this.id,
          status: "failed",
          evidence: [textEvidence(`Artifact is not valid JSON: ${input.artifact}`)],
        };
      }

      const errors = validateValue(parsed, input.schema, "$");
      return {
        validatorId: this.id,
        status: errors.length === 0 ? "passed" : "failed",
        evidence: [
          textEvidence(
            errors.length === 0 ? `Artifact matches schema: ${input.artifact}` : errors.join("\n"),
          ),
        ],
      };
    },
  };
}
