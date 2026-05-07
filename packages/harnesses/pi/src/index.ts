import { artifacts, collectors } from "@oma/runtime";
import type {
  Artifact,
  BoundEnvironment,
  CommandInput,
  CommandObserver,
  CommandResult,
  Harness,
  HarnessObservationInput,
  Objective,
} from "@oma/runtime";

export type PiHarnessMode = "json" | "print";

export type PiSessionMode = "none" | { dir: string };

export type PiHarnessOptions = {
  executable?: string;
  provider?: string;
  model?: string;
  mode?: PiHarnessMode;
  session?: PiSessionMode;
  timeoutMs?: number;
  objectivePath?: string;
  reportPath?: string;
  includePatch?: boolean;
  includeEmptyPatch?: boolean;
  includeEvents?: boolean;
  allowNonZeroExit?: boolean;
  maxEventLogBytes?: number;
  extraArgs?: string[];
};

const defaultExecutable = "pi";
const defaultObjectivePath = ".oma/pi-objective.md";
const defaultReportPath = ".oma/pi-report.md";
const defaultMaxEventLogBytes = 128_000;

export function renderPiObjective(
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

function boundedAppend(
  current: { text: string; truncated: boolean },
  chunk: string,
  maxBytes: number,
) {
  if (current.truncated) {
    return current;
  }

  const next = `${current.text}${chunk}`;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return {
      text: next,
      truncated: false,
    };
  }

  let end = next.length;
  while (end > 0 && Buffer.byteLength(next.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }

  return {
    text: next.slice(0, end),
    truncated: true,
  };
}

function recordValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function observation(
  input: HarnessObservationInput,
  optional: { label?: string | undefined; summary?: string | undefined } = {},
): HarnessObservationInput {
  const output: HarnessObservationInput = { ...input };
  if (optional.label !== undefined) {
    output.label = optional.label;
  }
  if (optional.summary !== undefined) {
    output.summary = optional.summary;
  }
  return output;
}

function piObservation(event: unknown): HarnessObservationInput | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  const type = recordValue(record, "type");

  switch (type) {
    case "session":
      return observation(
        {
          kind: "state",
          label: "session",
          status: "started",
        },
        {
          summary: recordValue(record, "id"),
        },
      );
    case "agent_start":
      return {
        kind: "state",
        label: "agent",
        status: "started",
      };
    case "agent_end":
      return {
        kind: "state",
        label: "agent",
        status: "completed",
      };
    case "turn_start":
      return {
        kind: "state",
        label: "turn",
        status: "started",
      };
    case "turn_end":
      return {
        kind: "state",
        label: "turn",
        status: "completed",
      };
    case "message_start":
      return {
        kind: "message",
        status: "started",
      };
    case "message_update":
      return {
        kind: "message",
        status: "updated",
      };
    case "message_end":
      return {
        kind: "message",
        status: "completed",
      };
    case "tool_execution_start":
      return observation(
        {
          kind: "tool",
          status: "started",
        },
        {
          label: recordValue(record, "toolName"),
        },
      );
    case "tool_execution_update":
      return observation(
        {
          kind: "tool",
          status: "updated",
        },
        {
          label: recordValue(record, "toolName"),
        },
      );
    case "tool_execution_end":
      return observation(
        {
          kind: "tool",
          status: booleanValue(record, "isError") ? "failed" : "completed",
        },
        {
          label: recordValue(record, "toolName"),
        },
      );
    case "compaction_start":
      return observation(
        {
          kind: "state",
          label: "compaction",
          status: "started",
        },
        {
          summary: recordValue(record, "reason"),
        },
      );
    case "compaction_end":
      return observation(
        {
          kind: "state",
          label: "compaction",
          status: booleanValue(record, "aborted") ? "failed" : "completed",
        },
        {
          summary: recordValue(record, "reason"),
        },
      );
    case "auto_retry_start":
      return observation(
        {
          kind: "state",
          label: "auto_retry",
          status: "started",
        },
        {
          summary: recordValue(record, "errorMessage"),
        },
      );
    case "auto_retry_end":
      return observation(
        {
          kind: "state",
          label: "auto_retry",
          status: booleanValue(record, "success") ? "completed" : "failed",
        },
        {
          summary: recordValue(record, "finalError"),
        },
      );
    case "extension_error":
      return observation(
        {
          kind: "state",
          label: "extension",
          status: "failed",
        },
        {
          summary: recordValue(record, "error"),
        },
      );
    default:
      return undefined;
  }
}

export function parsePiJsonl(text: string): unknown[] {
  const events: unknown[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Pi may emit non-protocol text on unexpected failures. Preserve it in logs.
    }
  }

  return events;
}

export async function runPiProcess(input: {
  environment: BoundEnvironment;
  executable: string;
  args: string[];
  timeoutMs?: number;
  observer?: CommandObserver;
}): Promise<CommandResult> {
  if (!input.environment.shell) {
    throw new Error("Pi harness requires an environment with shell capability.");
  }

  const commandInput: CommandInput = {
    command: input.executable,
    args: input.args,
  };

  if (input.timeoutMs !== undefined) {
    commandInput.timeoutMs = input.timeoutMs;
  }

  return await input.environment.shell.exec(commandInput, input.observer);
}

export function piHarness(options: PiHarnessOptions = {}): Harness {
  const executable = options.executable ?? defaultExecutable;
  const mode = options.mode ?? "json";
  const objectivePath = options.objectivePath ?? defaultObjectivePath;
  const reportPath = options.reportPath ?? defaultReportPath;
  const session = options.session ?? "none";
  const includePatch = options.includePatch ?? true;
  const includeEvents = options.includeEvents ?? true;
  const maxEventLogBytes = options.maxEventLogBytes ?? defaultMaxEventLogBytes;

  return {
    id: "pi",

    async run({ environment, objective, observe }) {
      if (!environment.filesystem) {
        throw new Error("Pi harness requires an environment with filesystem capability.");
      }

      const prompt = renderPiObjective(objective, { reportPath });
      await environment.filesystem.writeText(objectivePath, prompt);

      const args = ["--mode", mode];

      if (session === "none") {
        args.push("--no-session");
      } else {
        args.push("--session-dir", session.dir);
      }

      if (options.provider) {
        args.push("--provider", options.provider);
      }

      if (options.model) {
        args.push("--model", options.model);
      }

      args.push(...(options.extraArgs ?? []), prompt);

      let eventLog = {
        text: "",
        truncated: false,
      };

      const observed = new Set<string>();
      const observationWrites: Array<Promise<unknown>> = [];
      const processChunk = (chunk: string) => {
        eventLog = boundedAppend(eventLog, chunk, maxEventLogBytes);
      };

      let observedStdout = false;
      const processInput: {
        environment: BoundEnvironment;
        executable: string;
        args: string[];
        timeoutMs?: number;
        observer: CommandObserver;
      } = {
        environment,
        executable,
        args,
        observer: {
          stdout(chunk) {
            observedStdout = true;
            processChunk(chunk);
          },
        },
      };

      if (options.timeoutMs !== undefined) {
        processInput.timeoutMs = options.timeoutMs;
      }

      const result = await runPiProcess(processInput);

      if (!observedStdout) {
        processChunk(result.stdout);
      }

      for (const event of parsePiJsonl(eventLog.text)) {
        const key = JSON.stringify(event);
        if (observed.has(key)) {
          continue;
        }

        observed.add(key);
        const observation = piObservation(event);
        if (observation) {
          observationWrites.push(observe(observation));
        }
      }

      await Promise.all(observationWrites);

      if ((result.timedOut || result.exitCode !== 0) && !options.allowNonZeroExit) {
        throw new Error(
          `Pi failed: ${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`}`,
        );
      }

      const outputArtifacts: Artifact[] = [];

      try {
        outputArtifacts.push(await collectors.report(reportPath).collect({ environment }));
      } catch {
        // A missing report is handled below after patch/event/log collection.
      }

      if (includePatch && environment.git) {
        const patch = await collectors.gitDiff("changes.patch").collect({ environment });
        if (patch.content.trim().length > 0 || options.includeEmptyPatch) {
          outputArtifacts.push(patch);
        }
      }

      if (includeEvents && eventLog.text.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/pi-events.jsonl", eventLog.text));
      }

      if (result.stdout.length > 0 && mode !== "json") {
        outputArtifacts.push(artifacts.log(".oma/pi-stdout.log", result.stdout));
      }

      if (result.stderr.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/pi-stderr.log", result.stderr));
      }

      if (outputArtifacts.length === 0) {
        throw new Error("Pi completed without producing a report, patch, event, or log artifact.");
      }

      return {
        artifacts: outputArtifacts,
      };
    },
  };
}
