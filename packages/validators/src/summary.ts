import type { CommandEvidence, Evidence, ValidationResult } from "@oma/runtime";

export type ValidationFormatOptions = {
  full?: boolean;
  maxChars?: number;
};

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... truncated ${String(value.length - maxChars)} chars`;
}

function commandLine(evidence: CommandEvidence): string {
  const command = [evidence.command, ...evidence.args].join(" ");
  const exit = evidence.exitCode === null ? "no exit" : `exit ${String(evidence.exitCode)}`;
  const timeout = evidence.timedOut ? " timed out" : "";
  return `${command}: ${exit}${timeout} ${String(evidence.durationMs)}ms`;
}

export function formatEvidence(
  evidence: Evidence,
  options: ValidationFormatOptions = {},
): string[] {
  const maxChars = options.maxChars ?? 4_000;
  switch (evidence.kind) {
    case "artifact":
      return [`artifact ${evidence.name}: ${evidence.message}`];
    case "text":
      return [evidence.message];
    case "command": {
      const lines = [commandLine(evidence)];
      if (evidence.stdout.length > 0) {
        lines.push(
          `stdout: ${options.full ? evidence.stdout : truncate(evidence.stdout, maxChars)}`,
        );
      }
      if (evidence.stderr.length > 0) {
        lines.push(
          `stderr: ${options.full ? evidence.stderr : truncate(evidence.stderr, maxChars)}`,
        );
      }
      return lines;
    }
  }
}

export function formatValidationResult(
  result: ValidationResult,
  options: ValidationFormatOptions = {},
): string[] {
  return [
    `${result.status} ${result.validatorId}`,
    ...result.evidence.flatMap((evidence) =>
      formatEvidence(evidence, options).map((line) => `  ${line}`),
    ),
  ];
}

export function formatValidationSummary(
  validation: ValidationResult[],
  options: ValidationFormatOptions = {},
): string[] {
  if (validation.length === 0) {
    return ["No validation."];
  }
  return validation.flatMap((result) => formatValidationResult(result, options));
}
