import type { ValidationResult, Validator } from "@oma/runtime";
import { artifactEvidence } from "./evidence";

function namesOf(required: string | string[]): string[] {
  return Array.isArray(required) ? required : [required];
}

export function artifactExists(required: string | string[]): Validator {
  const requiredNames = namesOf(required);

  return {
    id: `artifact.exists:${requiredNames.join(",")}`,

    async validate({ artifacts }): Promise<ValidationResult> {
      const artifactNames = new Set(artifacts.map((artifact) => artifact.name));
      const missing = requiredNames.filter((name) => !artifactNames.has(name));

      if (missing.length === 0) {
        const found = artifacts.find((artifact) => artifact.name === requiredNames[0]);
        const evidenceInput: Parameters<typeof artifactEvidence>[0] = {
          message: `Found required artifact${requiredNames.length === 1 ? "" : "s"}: ${requiredNames.join(", ")}`,
          name: requiredNames.join(", "),
        };
        if (found) {
          evidenceInput.artifactId = found.id;
        }
        return {
          validatorId: this.id,
          status: "passed",
          evidence: [artifactEvidence(evidenceInput)],
        };
      }

      return {
        validatorId: this.id,
        status: "failed",
        evidence: [
          artifactEvidence({
            message: `Missing required artifact${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
            name: missing.join(", "),
          }),
        ],
      };
    },
  };
}
