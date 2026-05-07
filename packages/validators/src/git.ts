import type { ValidationResult, Validator } from "@oma/runtime";
import { textEvidence } from "./evidence";

export type GitDiffValidatorInput = {
  id?: string;
  required?: boolean;
  allowDirty?: boolean;
  maxBytes?: number;
};

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

export function gitDiffValidator(input: GitDiffValidatorInput = {}): Validator {
  const required = input.required ?? false;
  const allowDirty = input.allowDirty ?? true;
  const maxBytes = input.maxBytes ?? 4_000;

  return {
    id: input.id ?? `git.diff:${required ? "required" : allowDirty ? "allowed" : "clean"}`,

    async validate({ environment }): Promise<ValidationResult> {
      if (!environment.git) {
        return {
          validatorId: this.id,
          status: "failed",
          evidence: [textEvidence("Environment does not provide git capability.")],
        };
      }

      const diff = await environment.git.diff();
      const hasDiff = diff.trim().length > 0;
      const passed = required ? hasDiff : allowDirty || !hasDiff;
      const bounded = truncate(diff, maxBytes);
      const detail = hasDiff
        ? `Git diff is ${Buffer.byteLength(diff, "utf8")} bytes${bounded.truncated ? `; showing first ${String(maxBytes)} bytes.` : "."}`
        : "Git diff is empty.";

      return {
        validatorId: this.id,
        status: passed ? "passed" : "failed",
        evidence: [textEvidence(bounded.text.length > 0 ? `${detail}\n${bounded.text}` : detail)],
      };
    },
  };
}
