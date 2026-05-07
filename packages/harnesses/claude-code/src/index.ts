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

export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeCodePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type ClaudeCodeHarnessOptions = {
  executable?: string;
  model?: string;
  effort?: ClaudeCodeEffort;
  permissionMode?: ClaudeCodePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  bare?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpConfig?: string[];
  settings?: string;
  settingSources?: string[];
  addDir?: string[];
  sessionId?: string;
  name?: string;
  objectivePath?: string;
  reportPath?: string;
  includePatch?: boolean;
  includeEmptyPatch?: boolean;
  includeEvents?: boolean;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  noSessionPersistence?: boolean;
  dangerouslySkipPermissions?: boolean;
  allowDangerouslySkipPermissions?: boolean;
  allowNonZeroExit?: boolean;
  timeoutMs?: number;
  maxEventLogBytes?: number;
  extraArgs?: string[];
};

const defaultExecutable = "claude";
const defaultObjectivePath = ".oma/claude-objective.md";
const defaultReportPath = ".oma/claude-report.md";
const defaultMaxEventLogBytes = 128_000;

export function renderClaudeCodeObjective(
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

function messageStatus(type: string): HarnessObservationInput["status"] {
  if (type.includes("delta") || type.includes("partial")) {
    return "updated";
  }
  if (type.includes("result") || type.includes("assistant")) {
    return "completed";
  }
  return undefined;
}

function toolLabelFromStreamEvent(record: Record<string, unknown>): string | undefined {
  const event = nestedRecord(record, "event");
  const contentBlock = event ? nestedRecord(event, "content_block") : undefined;
  const delta = event ? nestedRecord(event, "delta") : undefined;

  return (
    (contentBlock ? recordValue(contentBlock, "name") : undefined) ??
    (contentBlock ? recordValue(contentBlock, "type") : undefined) ??
    (delta ? recordValue(delta, "type") : undefined)
  );
}

export function claudeCodeObservation(event: unknown): HarnessObservationInput | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  const type = recordValue(record, "type");
  if (!type) {
    return undefined;
  }

  const normalized = type.toLowerCase();
  const subtype = recordValue(record, "subtype");
  const summary =
    recordValue(record, "result") ??
    recordValue(record, "message") ??
    recordValue(record, "error") ??
    subtype;

  if (normalized === "stream_event") {
    const streamEvent = nestedRecord(record, "event");
    const streamType = streamEvent ? recordValue(streamEvent, "type") : undefined;
    const contentBlock = streamEvent ? nestedRecord(streamEvent, "content_block") : undefined;
    const contentType = contentBlock ? recordValue(contentBlock, "type") : undefined;
    const delta = streamEvent ? nestedRecord(streamEvent, "delta") : undefined;
    const deltaType = delta ? recordValue(delta, "type") : undefined;
    const label = toolLabelFromStreamEvent(record);

    if (contentType === "tool_use" || deltaType === "input_json_delta") {
      return observation(
        {
          kind: "tool",
        },
        {
          label,
          status: streamType?.includes("start") ? "started" : "updated",
        },
      );
    }

    return observation(
      {
        kind: "message",
      },
      {
        status: streamType?.includes("delta") ? "updated" : "completed",
      },
    );
  }

  if (normalized === "assistant") {
    return observation(
      {
        kind: "message",
      },
      {
        status: "completed",
        summary,
      },
    );
  }

  if (normalized === "result") {
    return observation(
      {
        kind: subtype === "success" ? "message" : "state",
      },
      {
        label: subtype,
        status: subtype === "success" ? "completed" : "failed",
        summary,
      },
    );
  }

  if (normalized === "system") {
    return observation(
      {
        kind: "state",
        label: subtype ?? "system",
      },
      {
        status: "started",
        summary,
      },
    );
  }

  if (normalized.includes("hook")) {
    return observation(
      {
        kind: "state",
        label: type,
      },
      {
        status: normalized.includes("error") || normalized.includes("fail") ? "failed" : "updated",
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
        status: messageStatus(normalized),
        summary,
      },
    );
  }

  return undefined;
}

export function parseClaudeCodeJsonl(text: string): unknown[] {
  const events: unknown[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Claude Code may emit non-protocol text on unexpected failures. Preserve it in logs.
    }
  }

  return events;
}

export async function runClaudeCodeProcess(input: {
  environment: BoundEnvironment;
  executable: string;
  args: string[];
  stdin?: string;
  timeoutMs?: number;
  observer?: CommandObserver;
}): Promise<CommandResult> {
  if (!input.environment.shell) {
    throw new Error("Claude Code harness requires an environment with shell capability.");
  }

  const commandInput: CommandInput = {
    command: input.executable,
    args: input.args,
  };

  if (input.stdin !== undefined) {
    commandInput.stdin = input.stdin;
  }

  if (input.timeoutMs !== undefined) {
    commandInput.timeoutMs = input.timeoutMs;
  }

  return await input.environment.shell.exec(commandInput, input.observer);
}

function pushRepeated(args: string[], flag: string, values: string[] | undefined): void {
  for (const value of values ?? []) {
    args.push(flag, value);
  }
}

export function claudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): Harness {
  const executable = options.executable ?? defaultExecutable;
  const objectivePath = options.objectivePath ?? defaultObjectivePath;
  const reportPath = options.reportPath ?? defaultReportPath;
  const includePatch = options.includePatch ?? true;
  const includeEvents = options.includeEvents ?? true;
  const noSessionPersistence = options.noSessionPersistence ?? true;
  const maxEventLogBytes = options.maxEventLogBytes ?? defaultMaxEventLogBytes;

  return {
    id: "claude-code",

    async run({ environment, objective, observe }) {
      if (!environment.filesystem) {
        throw new Error("Claude Code harness requires an environment with filesystem capability.");
      }

      const prompt = renderClaudeCodeObjective(objective, { reportPath });
      await environment.filesystem.writeText(objectivePath, prompt);

      const args = ["-p", "--output-format", "stream-json", "--verbose"];

      if (noSessionPersistence) {
        args.push("--no-session-persistence");
      }

      if (options.bare) {
        args.push("--bare");
      }

      if (options.includePartialMessages) {
        args.push("--include-partial-messages");
      }

      if (options.includeHookEvents) {
        args.push("--include-hook-events");
      }

      if (options.dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
      }

      if (options.allowDangerouslySkipPermissions) {
        args.push("--allow-dangerously-skip-permissions");
      }

      if (options.model) {
        args.push("--model", options.model);
      }

      if (options.effort) {
        args.push("--effort", options.effort);
      }

      if (options.permissionMode) {
        args.push("--permission-mode", options.permissionMode);
      }

      if (options.maxTurns !== undefined) {
        args.push("--max-turns", String(options.maxTurns));
      }

      if (options.maxBudgetUsd !== undefined) {
        args.push("--max-budget-usd", String(options.maxBudgetUsd));
      }

      if (options.settings) {
        args.push("--settings", options.settings);
      }

      if (options.settingSources && options.settingSources.length > 0) {
        args.push("--setting-sources", options.settingSources.join(","));
      }

      if (options.sessionId) {
        args.push("--session-id", options.sessionId);
      }

      if (options.name) {
        args.push("--name", options.name);
      }

      pushRepeated(args, "--allowedTools", options.allowedTools);
      pushRepeated(args, "--disallowedTools", options.disallowedTools);
      pushRepeated(args, "--tools", options.tools);
      pushRepeated(args, "--mcp-config", options.mcpConfig);
      pushRepeated(args, "--add-dir", options.addDir);

      args.push(...(options.extraArgs ?? []));

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
        stdin: string;
        timeoutMs?: number;
        observer: CommandObserver;
      } = {
        environment,
        executable,
        args,
        stdin: prompt,
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

      const result = await runClaudeCodeProcess(processInput);

      if (!observedStdout) {
        processChunk(result.stdout);
      }

      for (const event of parseClaudeCodeJsonl(eventLog.text)) {
        const key = JSON.stringify(event);
        if (observed.has(key)) {
          continue;
        }

        observed.add(key);
        const normalized = claudeCodeObservation(event);
        if (normalized) {
          observationWrites.push(observe(normalized));
        }
      }

      await Promise.all(observationWrites);

      if ((result.timedOut || result.exitCode !== 0) && !options.allowNonZeroExit) {
        throw new Error(
          `Claude Code failed: ${result.timedOut ? "timed out" : `exit ${String(result.exitCode)}`}`,
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
        outputArtifacts.push(artifacts.log(".oma/claude-events.jsonl", eventLog.text));
      }

      if (result.stderr.length > 0) {
        outputArtifacts.push(artifacts.log(".oma/claude-stderr.log", result.stderr));
      }

      if (outputArtifacts.length === 0) {
        throw new Error(
          "Claude Code completed without producing a report, patch, event, or log artifact.",
        );
      }

      return {
        artifacts: outputArtifacts,
      };
    },
  };
}
