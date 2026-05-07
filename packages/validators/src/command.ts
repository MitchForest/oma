import type { CommandInput, CommandResult, ValidationResult, Validator } from "@oma/runtime";
import { commandEvidence, textEvidence } from "./evidence";

export type CommandValidatorInput = CommandInput & {
  id?: string;
  success?: (result: CommandResult) => boolean;
};

export function commandValidator(input: CommandValidatorInput): Validator {
  const args = input.args ?? [];
  const id = input.id ?? `command:${[input.command, ...args].join(" ")}`;

  return {
    id,

    async validate({ environment }): Promise<ValidationResult> {
      if (!environment.shell) {
        return {
          validatorId: id,
          status: "failed",
          evidence: [textEvidence("Environment does not provide shell capability.")],
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

export function testValidator(
  input: Omit<CommandValidatorInput, "id"> & { id?: string },
): Validator {
  return commandValidator({
    ...input,
    id: input.id ?? `test:${[input.command, ...(input.args ?? [])].join(" ")}`,
  });
}

export function typecheckValidator(
  input: Omit<CommandValidatorInput, "id"> & { id?: string },
): Validator {
  return commandValidator({
    ...input,
    id: input.id ?? `typecheck:${[input.command, ...(input.args ?? [])].join(" ")}`,
  });
}

export function lintValidator(
  input: Omit<CommandValidatorInput, "id"> & { id?: string },
): Validator {
  return commandValidator({
    ...input,
    id: input.id ?? `lint:${[input.command, ...(input.args ?? [])].join(" ")}`,
  });
}
