import type { ValidationResult, Validator } from "@oma/runtime";
import { textEvidence } from "./evidence";

async function runChild(
  validator: Validator,
  input: Parameters<Validator["validate"]>[0],
): Promise<ValidationResult> {
  try {
    return await validator.validate(input);
  } catch (error) {
    return {
      validatorId: validator.id,
      status: "failed",
      evidence: [textEvidence(error instanceof Error ? error.message : "Validator failed.")],
    };
  }
}

function evidenceFrom(results: ValidationResult[]) {
  return results.flatMap((result) => [
    textEvidence(`${result.status} ${result.validatorId}`),
    ...result.evidence,
  ]);
}

export function all(id: string, children: Validator[]): Validator {
  return {
    id,
    async validate(input): Promise<ValidationResult> {
      const results = [];
      for (const child of children) {
        results.push(await runChild(child, input));
      }
      return {
        validatorId: id,
        status: results.every((result) => result.status === "passed") ? "passed" : "failed",
        evidence: evidenceFrom(results),
      };
    },
  };
}

export function any(id: string, children: Validator[]): Validator {
  return {
    id,
    async validate(input): Promise<ValidationResult> {
      const results = [];
      for (const child of children) {
        results.push(await runChild(child, input));
      }
      return {
        validatorId: id,
        status: results.some((result) => result.status === "passed") ? "passed" : "failed",
        evidence: evidenceFrom(results),
      };
    },
  };
}

export function sequence(id: string, children: Validator[]): Validator {
  return {
    id,
    async validate(input): Promise<ValidationResult> {
      const results = [];
      for (const child of children) {
        const result = await runChild(child, input);
        results.push(result);
        if (result.status === "failed") {
          break;
        }
      }
      return {
        validatorId: id,
        status: results.every((result) => result.status === "passed") ? "passed" : "failed",
        evidence: evidenceFrom(results),
      };
    },
  };
}
