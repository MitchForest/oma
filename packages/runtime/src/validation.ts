import type {
  Artifact,
  BoundEnvironment,
  Objective,
  Session,
  ValidationResult,
  Validator,
} from "./types";

export async function validateArtifacts(input: {
  objective: Objective;
  artifacts: Artifact[];
  environment: BoundEnvironment;
  session: Session;
  validators: Validator[];
}): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const validator of input.validators) {
    try {
      results.push(
        await validator.validate({
          objective: input.objective,
          artifacts: input.artifacts,
          environment: input.environment,
          session: input.session,
        }),
      );
    } catch (error) {
      results.push({
        validatorId: validator.id,
        status: "failed",
        evidence: [
          {
            kind: "text",
            message: error instanceof Error ? error.message : "Validator failed.",
          },
        ],
      });
    }
  }

  return results;
}
