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

export type OpencodeHarnessOptions = {
  executable?: string;
  model?: string;
  agent?: string;
  command?: string;
  attach?: string;
  title?: string;
  files?: string[];
  dir?: string;
  pure?: boolean;
  dangerouslySkipPermissions?: boolean;
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

const defaultExecutable = "opencode";
const defaultObjectivePath = ".oma/opencode-objective.md";
const defaultReportPath = ".oma/opencode-report.md";
const defaultMaxEventLogBytes = 128_000;

export function renderOpencodeObjective(
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

function nestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function observation(
  input: HarnessObservationInput,
  optional: {
    label?: string | undefined;
    status?: HarnessObservationInput["status"] | undefined;
    summary?: string | undefined;
  } = {},
): HarnessObservationInput {
  const output: HarnessObservationInput = { ...input };
  if (optional.label !== undefined) {
    output.label = optional.label;
  }
  if (optional.status !== undefined) {
    output.status = optional.status;
  }
  if (optional.summary !== undefined) {
    output.summary = optional.summary;
  }
  return output;
}

function eventType(record: Record<string, unknown>): string | undefined {
  return (
    recordValue(record, "type") ??
    recordValue(record, "event") ??
    recordValue(record, "name") ??
    recordValue(record, "kind")
  );
}

function toolLabel(record: Record<string, unknown>): string | undefined {
  const tool = nestedRecord(record, "tool");
  return (
    recordValue(record, "tool") ??
    recordValue(record, "toolName") ??
    recordValue(record, "tool_name") ??
    recordValue(record, "name") ??
    (tool ? recordValue(tool, "name") : undefined)
  );
}

function statusFor(
  type: string,
  record: Record<string, unknown>,
): HarnessObservationInput["status"] {
  if (booleanValue(record, "error") || booleanValue(record, "isError")) {
    return "failed";
  }

  if (type.includes("start") || type.includes("created") || type.includes("init")) {
    return "started";
  }

  if (type.includes("update") || type.includes("delta") || type.includes("progress")) {
    return "updated";
  }

  if (
    type.includes("end") ||
    type.includes("complete") ||
    type.includes("done") ||
    type.includes("finish")
  ) {
    return "completed";
  }

  if (type.includes("error") || type.includes("fail")) {
    return "failed";
  }

  return undefined;
}

export function opencodeObservation(event: unknown): HarnessObservationInput | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  const type = eventType(record);
  if (!type) {
    return undefined;
  }

  const normalized = type.toLowerCase();
  const summary =
    recordValue(record, "message") ??
    recordValue(record, "summary") ??
    recordValue(record, "title") ??
    recordValue(record, "error");

  if (normalized.includes("tool")) {
    return observation(
      {
        kind: "tool",
      },
      {
        label: toolLabel(record),
        status: statusFor(normalized, record),
        summary,
      },
    );
  }

  if (
    normalized.includes("message") ||
    normalized.includes("assistant") ||
    normalized.includes("part")
  ) {
    return observation(
      {
        kind: "message",
      },
      {
        status: statusFor(normalized, record),
        summary,
      },
    );
  }

  if (normalized.includes("usage") || normalized.includes("token") || normalized.includes("cost")) {
    return observation(
      {
        kind: "usage",
      },
      {
        status: statusFor(normalized, record),
        summary,
      },
    );
  }

  if (
    normalized.includes("session") ||
    normalized.includes("permission") ||
    normalized.includes("snapshot") ||
    normalized.includes("agent") ||
    normalized.includes("run")
  ) {
    return observation(
      {
        kind: "state",
        label: type,
      },
      {
        status: statusFor(normalized, record),
        summary,
      },
    );
  }

  return undefined;
}

export function parseOpencodeJsonl(text: string): unknown[] {
  const events: unknown[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // OpenCode may emit non-protocol text on unexpected failures. Preserve it in logs.
    }
  }

  return events;
}

export async function runOpencodeProcess(input: {
  environment: BoundEnvironment;
  executable: string;
  args: string[];
  timeoutMs?: number;
  observer?: CommandObserver;
}): Promise<CommandResult> {
  if (!input.environment.shell) {
    throw new Error("OpenCode harness requires an environment with shell capability.");
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

export function opencodeHarness(options: OpencodeHarnessOptions = {}): Harness {
  const executable = options.executable ?? defaultExecutable;
  const command = options.command ?? "run";
  const objectivePath = options.objectivePath ?? defaultObjectivePath;
  const reportPath = options.reportPath ?? defaultReportPath;
  const includePatch = options.includePatch ?? true;
  const includeEvents = options.includeEvents ?? true;
  const maxEventLogBytes = options.maxEventLogBytes ?? defaultMaxEventLogBytes;

  return {
    id: "opencode",

    async run({ environment, objective, observe }) {
      if (!environment.filesystem) {
        throw new Error("OpenCode harness requires an environment with filesystem capability.");
      }

      const prompt = renderOpencodeObjective(objective, { reportPath });
      await environment.filesystem.writeText(objectivePath, prompt);

      const args = [command, "--format", "json"];

      if (options.model) {
        args.push("--model", options.model);
      }

      if (options.agent) {
        args.push("--agent", options.agent);
      }

      if (options.attach) {
        args.push("--attach", options.attach);
      }

      if (options.title) {
        args.push("--title", options.title);
      }

      if (options.dir) {
        args.push("--dir", options.dir);
      }

      if (options.pure) {
        args.push("--pure");
      }

      if (options.dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }

      for (const file of options.files ?? []) {
        args.push("--file", file);
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

      const result = await runOpencodeProcess(processInput);

      if (!observedStdout) {
        processChunk(result.stdout);
      }

      for (const event of parseOpencodeJsonl(eventLog.text)) {
        const key = JSON.stringify(event);
        if (observed.has(key)) {
          continue;
        }

        observed.add(key);
        const normalized = opencodeObservation(event);
        if (normalized) {
          observationWrites.push(observe(normalized));
        }
      }

      await Promise.all(observationWrites);

      if ((result.timedOut || result.exitCode !== 0) && !options.allowNonZeroExit) {
        throw new Error(
          `OpenCode failed: ${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`}`,
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
        outputArtifacts.push(artifacts.log(".oma/opencode-events.jsonl", eventLog.text));
      }

      if (result.stderr.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/opencode-stderr.log", result.stderr));
      }

      if (outputArtifacts.length === 0) {
        throw new Error(
          "OpenCode completed without producing a report, patch, event, or log artifact.",
        );
      }

      return {
        artifacts: outputArtifacts,
      };
    },
  };
}
