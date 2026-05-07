import type { CommandResult, Evidence } from "@oma/runtime";

export function textEvidence(message: string): Evidence {
  return {
    kind: "text",
    message,
  };
}

export function commandEvidence(result: CommandResult): Evidence {
  return {
    kind: "command",
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

export function artifactEvidence(input: {
  name: string;
  message: string;
  artifactId?: string;
}): Evidence {
  const evidence: Evidence = {
    kind: "artifact",
    message: input.message,
    name: input.name,
  };
  if (input.artifactId) {
    evidence.artifactId = input.artifactId;
  }
  return evidence;
}
