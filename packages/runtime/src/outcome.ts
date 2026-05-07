import type { OutcomeStatus, ValidationResult } from "./types";

export function statusFromValidation(validation: ValidationResult[]): OutcomeStatus {
  if (validation.some((result) => result.status === "failed")) {
    return "failed";
  }

  if (validation.some((result) => result.status === "inconclusive")) {
    return "inconclusive";
  }

  return "succeeded";
}
