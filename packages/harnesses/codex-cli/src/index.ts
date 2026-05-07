import { artifacts, collectors } from "@oma/runtime";
import type {
  Artifact,
  BoundEnvironment,
  CommandInput,
  CommandResult,
  Harness,
  Objective,
} from "@oma/runtime";

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexCliHarnessOptions = {
  executable?: string;
  model?: string;
  profile?: string;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  timeoutMs?: number;
  objectivePath?: string;
  reportPath?: string;
  includePatch?: boolean;
  includeEmptyPatch?: boolean;
  skipGitRepoCheck?: boolean;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  allowNonZeroExit?: boolean;
  extraArgs?: string[];
};

const defaultExecutable = "codex";
const defaultObjectivePath = ".oma/codex-objective.md";
const defaultReportPath = ".oma/codex-report.md";

export function renderCodexObjective(
  objective: Objective,
  options: { reportPath?: string } = {},
): string {
  const reportPath = options.reportPath ?? defaultReportPath;
  const constraints =
    objective.constraints.length > 0
      ? objective.constraints.map((constraint) => `- ${constraint}`).join("\n")
      : "- No explicit constraints.";
  const success =
    objective.success.length > 0
      ? objective.success.map((criterion) => `- ${criterion}`).join("\n")
      : "- Produce an inspectable result.";

  return [
    "# Objective",
    "",
    objective.goal,
    "",
    "## Constraints",
    "",
    constraints,
    "",
    "## Success Criteria",
    "",
    success,
    "",
    "## Expected Output",
    "",
    `- Write a concise final report to \`${reportPath}\`.`,
    "- If code changes are needed, edit the workspace directly.",
    "- Do not run validation commands unless the objective explicitly asks for them; OMA validators run after the harness.",
    "- Keep changes focused on the objective.",
    "",
  ].join("\n");
}

export async function runHarnessProcess(input: {
  environment: BoundEnvironment;
  executable: string;
  args: string[];
  timeoutMs?: number;
}): Promise<CommandResult> {
  if (!input.environment.shell) {
    throw new Error("Codex CLI harness requires an environment with shell capability.");
  }

  const commandInput: CommandInput = {
    command: input.executable,
    args: input.args,
  };

  if (input.timeoutMs !== undefined) {
    commandInput.timeoutMs = input.timeoutMs;
  }

  return await input.environment.shell.exec(commandInput);
}

export function codexCliHarness(options: CodexCliHarnessOptions = {}): Harness {
  const executable = options.executable ?? defaultExecutable;
  const objectivePath = options.objectivePath ?? defaultObjectivePath;
  const reportPath = options.reportPath ?? defaultReportPath;
  const includePatch = options.includePatch ?? true;

  return {
    id: "codex-cli",

    async run({ objective, environment }) {
      if (!environment.filesystem) {
        throw new Error("Codex CLI harness requires an environment with filesystem capability.");
      }

      const prompt = renderCodexObjective(objective, { reportPath });
      await environment.filesystem.writeText(objectivePath, prompt);

      const args = [
        "exec",
        "--cd",
        ".",
        "--sandbox",
        options.sandbox ?? "workspace-write",
        "--output-last-message",
        reportPath,
      ];

      if (options.approvalPolicy) {
        args.push("-c", `approval_policy="${options.approvalPolicy}"`);
      }

      if (options.model) {
        args.push("--model", options.model);
      }

      if (options.profile) {
        args.push("--profile", options.profile);
      }

      if (options.skipGitRepoCheck) {
        args.push("--skip-git-repo-check");
      }

      if (options.dangerouslyBypassApprovalsAndSandbox) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }

      args.push(...(options.extraArgs ?? []), prompt);

      const processInput: {
        environment: BoundEnvironment;
        executable: string;
        args: string[];
        timeoutMs?: number;
      } = {
        environment,
        executable,
        args,
      };

      if (options.timeoutMs !== undefined) {
        processInput.timeoutMs = options.timeoutMs;
      }

      const result = await runHarnessProcess(processInput);

      if ((result.timedOut || result.exitCode !== 0) && !options.allowNonZeroExit) {
        throw new Error(
          `Codex CLI failed: ${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`}`,
        );
      }

      const outputArtifacts: Artifact[] = [];

      try {
        outputArtifacts.push(await collectors.report(reportPath).collect({ environment }));
      } catch {
        // A missing report is handled below after patch/log collection.
      }

      if (includePatch && environment.git) {
        const patch = await collectors.gitDiff("changes.patch").collect({ environment });
        if (patch.content.trim().length > 0 || options.includeEmptyPatch) {
          outputArtifacts.push(patch);
        }
      }

      if (result.stdout.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/codex-stdout.log", result.stdout));
      }

      if (result.stderr.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/codex-stderr.log", result.stderr));
      }

      if (outputArtifacts.length === 0) {
        throw new Error("Codex CLI completed without producing a report, patch, or log artifact.");
      }

      return {
        artifacts: outputArtifacts,
      };
    },
  };
}
