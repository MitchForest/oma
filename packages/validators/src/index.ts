import { artifactExists } from "./artifact";
import { commandValidator, lintValidator, testValidator, typecheckValidator } from "./command";
import { all, any, sequence } from "./compose";
import { gitDiffValidator } from "./git";
import { schemaValidator } from "./schema";

export { artifactExists };
export { commandValidator, lintValidator, testValidator, typecheckValidator } from "./command";
export type { CommandValidatorInput } from "./command";
export { all, any, sequence } from "./compose";
export { artifactEvidence, commandEvidence, textEvidence } from "./evidence";
export { gitDiffValidator } from "./git";
export type { GitDiffValidatorInput } from "./git";
export { schemaValidator } from "./schema";
export type { JsonSchema, SchemaValidatorInput } from "./schema";
export { formatEvidence, formatValidationResult, formatValidationSummary } from "./summary";
export type { ValidationFormatOptions } from "./summary";

export const validators = {
  all,
  any,
  artifactExists,
  command: commandValidator,
  gitDiff: gitDiffValidator,
  lint: lintValidator,
  schema: schemaValidator,
  sequence,
  test: testValidator,
  typecheck: typecheckValidator,
};
