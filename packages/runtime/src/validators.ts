import type { CommandInput, CommandResult, ValidationResult, Validator } from "./types";

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
        return {
          validatorId: this.id,
          status: "passed",
          evidence: [
            found
              ? {
                  artifactId: found.id,
                  kind: "artifact",
                  message: `Found required artifact${requiredNames.length === 1 ? "" : "s"}: ${requiredNames.join(", ")}`,
                  name: requiredNames.join(", "),
                }
              : {
                  kind: "artifact",
                  message: `Found required artifact${requiredNames.length === 1 ? "" : "s"}: ${requiredNames.join(", ")}`,
                  name: requiredNames.join(", "),
                },
          ],
        };
      }

      return {
        validatorId: this.id,
        status: "failed",
        evidence: [
          {
            kind: "artifact",
            message: `Missing required artifact${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
            name: missing.join(", "),
          },
        ],
      };
    },
  };
}

export function inconclusive(id: string, message: string): Validator {
  return {
    id,

    async validate(): Promise<ValidationResult> {
      return {
        validatorId: id,
        status: "inconclusive",
        evidence: [
          {
            kind: "text",
            message,
          },
        ],
      };
    },
  };
}

function commandEvidence(result: CommandResult) {
  return {
    kind: "command" as const,
    command: result.command,
    args: result.args,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
    timedOut: result.timedOut,
    truncated: result.truncated,
  };
}

export function commandValidator(
  input: CommandInput & {
    id?: string;
    success?: (result: CommandResult) => boolean;
  },
): Validator {
  const args = input.args ?? [];
  const id = input.id ?? `command:${[input.command, ...args].join(" ")}`;

  return {
    id,

    async validate({ environment }): Promise<ValidationResult> {
      if (!environment.shell) {
        return {
          validatorId: id,
          status: "failed",
          evidence: [
            {
              kind: "text",
              message: "Environment does not provide shell capability.",
            },
          ],
        };
      }

      const result = await environment.shell.exec(input);
      const passed = input.success
        ? input.success(result)
        : result.exitCode === 0 && !result.timedOut;

      return {
        validatorId: id,
        status: passed ? "passed" : "failed",
        evidence: [commandEvidence(result)],
      };
    },
  };
}

export const validators = {
  artifactExists,
  command: commandValidator,
  inconclusive,
};
