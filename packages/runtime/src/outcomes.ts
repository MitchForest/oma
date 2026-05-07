import type {
  BoundEnvironment,
  CommandEvidence,
  Environment,
  Evidence,
  Outcome,
  OutcomeJsonV1,
  Session,
} from "./types";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function evidenceLine(evidence: Evidence): string {
  switch (evidence.kind) {
    case "artifact":
      return `artifact ${evidence.name}: ${evidence.message}`;
    case "command":
      return commandEvidenceLine(evidence);
    case "text":
      return evidence.message;
  }
}

function commandEvidenceLine(evidence: CommandEvidence): string {
  const command = [evidence.command, ...evidence.args].join(" ");
  const exit = evidence.exitCode === null ? "no exit code" : `exit ${evidence.exitCode}`;
  const timeout = evidence.timedOut ? ", timed out" : "";
  return `${command}: ${exit} in ${evidence.durationMs}ms${timeout}`;
}

export function toJson(outcome: Outcome): OutcomeJsonV1 {
  return {
    schemaVersion: 1,
    runId: outcome.runId,
    status: outcome.status,
    objective: outcome.objective,
    artifacts: outcome.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: byteLength(artifact.content),
    })),
    validation: outcome.validation,
    eventCount: outcome.events.length,
  };
}

export function toMarkdown(outcome: Outcome): string {
  const lines = [
    "# OMA Outcome",
    "",
    `**Status:** ${outcome.status}`,
    `**Run:** ${outcome.runId}`,
    `**Events:** ${outcome.events.length}`,
    "",
    "## Objective",
    "",
    outcome.objective.goal,
    "",
    "## Constraints",
    "",
    ...(outcome.objective.constraints.length > 0
      ? outcome.objective.constraints.map((constraint) => `- ${constraint}`)
      : ["No constraints."]),
    "",
    "## Success Criteria",
    "",
    ...(outcome.objective.success.length > 0
      ? outcome.objective.success.map((criterion) => `- ${criterion}`)
      : ["No success criteria."]),
    "",
    "## Artifacts",
    "",
  ];

  if (outcome.artifacts.length === 0) {
    lines.push("No artifacts.");
  } else {
    for (const artifact of outcome.artifacts) {
      lines.push(
        `- ${artifact.name} - ${artifact.kind}, ${artifact.mediaType}, ${byteLength(artifact.content)} bytes`,
      );
    }
  }

  lines.push("", "## Validation", "");

  if (outcome.validation.length === 0) {
    lines.push("No validation.");
  } else {
    for (const result of outcome.validation) {
      lines.push(`- ${result.status} - ${result.validatorId}`);
      for (const evidence of result.evidence) {
        lines.push(`  - ${evidenceLine(evidence)}`);
      }
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeOutcome(
  outcome: Outcome,
  input:
    | {
        environment: BoundEnvironment;
        jsonPath: string;
        markdownPath: string;
      }
    | {
        environment: Environment;
        session: Session;
        jsonPath: string;
        markdownPath: string;
      },
): Promise<void> {
  const environment =
    "session" in input
      ? input.environment.bind({
          runId: outcome.runId,
          session: input.session,
        })
      : input.environment;

  if (!environment.filesystem) {
    throw new Error("Environment does not provide filesystem capability.");
  }

  await environment.filesystem.writeText(
    input.jsonPath,
    `${JSON.stringify(toJson(outcome), null, 2)}\n`,
  );
  await environment.filesystem.writeText(input.markdownPath, toMarkdown(outcome));
}

export const outcomes = {
  toJson,
  toMarkdown,
  write: writeOutcome,
};
