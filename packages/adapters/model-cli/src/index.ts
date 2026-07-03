import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInput, ModelProvider, ModelTurn } from "@oma/core";

/**
 * Model providers that ride the coding-agent CLIs the user is already logged
 * into — no API keys, the existing Claude Code / Codex subscription is the
 * credential. Each turn shells out non-interactively; the harness does its
 * own tool use in the working directory and returns a final message.
 *
 * Continuity is threaded through the durable log: the harness's session id
 * is recorded as the turn's `requestId`, and the next turn resumes it — so
 * OMA resumes and loop iterations keep the harness's own conversation.
 *
 * Trust note: a stage on one of these models runs with that harness's local
 * powers. Codex is contained by its own sandbox (`workspace-write` default);
 * Claude Code runs headless with permissions bypassed — treat such stages
 * like `run:` code, and isolate with a scratch checkout or worker when in
 * doubt. OMA's effects policy governs OMA tools, not the external harness.
 */

const defaultTimeoutMs = 30 * 60 * 1000;

interface BaseCliOptions {
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Extra argv appended verbatim. */
  args?: string[];
}

export interface ClaudeCodeModelOptions extends BaseCliOptions {
  /** Model name or alias passed to --model (e.g. "claude-opus-4-8", "opus"). */
  model?: string;
}

export interface CodexModelOptions extends BaseCliOptions {
  /** Model passed to -m (e.g. "gpt-5.5"). */
  model?: string;
  /** Reasoning effort (model_reasoning_effort config), e.g. "medium". */
  effort?: string;
  /** Codex's own sandbox policy. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export function createClaudeCodeModel(options: ClaudeCodeModelOptions = {}): ModelProvider {
  return {
    info: { provider: "claude-code", model: options.model },
    async turn(input: ModelInput): Promise<ModelTurn> {
      const prompt = nextPrompt(input);

      if (prompt === undefined) {
        return { finishReason: "stop" };
      }

      const argv = [options.binary ?? "claude", "-p", prompt, "--output-format", "json"];

      if (options.model) {
        argv.push("--model", options.model);
      }

      const resumeId = priorHarnessSession(input);

      if (resumeId) {
        argv.push("--resume", resumeId);
      }

      // Headless runs cannot answer permission prompts; the workflow file is
      // the reviewed control surface, the harness runs unattended.
      argv.push("--dangerously-skip-permissions");
      argv.push(...(options.args ?? []));

      const stdout = await run(argv, options);
      const parsed = JSON.parse(lastJsonLine(stdout)) as {
        result?: string;
        session_id?: string;
        is_error?: boolean;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      if (parsed.is_error) {
        throw new Error(`claude -p reported an error: ${parsed.result ?? "(no result)"}`);
      }

      return {
        content: parsed.result ?? "",
        requestId: parsed.session_id,
        usage: {
          inputTokens: parsed.usage?.input_tokens,
          outputTokens: parsed.usage?.output_tokens
        }
      };
    }
  };
}

export function createCodexModel(options: CodexModelOptions = {}): ModelProvider {
  return {
    info: { provider: "codex", model: options.model },
    async turn(input: ModelInput): Promise<ModelTurn> {
      const prompt = nextPrompt(input);

      if (prompt === undefined) {
        return { finishReason: "stop" };
      }

      const lastMessagePath = join(mkdtempSync(join(tmpdir(), "oma-codex-")), "last.txt");
      const resumeId = priorHarnessSession(input);
      const argv = [options.binary ?? "codex", "exec"];

      if (resumeId) {
        argv.push("resume", resumeId);
      }

      argv.push(
        "--json",
        "--output-last-message",
        lastMessagePath,
        "--skip-git-repo-check",
        "--color",
        "never",
        "-s",
        options.sandbox ?? "workspace-write"
      );

      if (options.model) {
        argv.push("-m", options.model);
      }

      if (options.effort) {
        argv.push("-c", `model_reasoning_effort="${options.effort}"`);
      }

      argv.push(...(options.args ?? []), prompt);

      const stdout = await run(argv, options);
      let threadId: string | undefined;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;

      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) {
          continue;
        }

        try {
          const event = JSON.parse(line) as Record<string, unknown>;

          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            threadId = event.thread_id;
          } else if (event.type === "turn.completed" && event.usage) {
            usage = event.usage as { input_tokens?: number; output_tokens?: number };
          }
        } catch {
          // non-JSON output line; ignore
        }
      }

      const content = (await Bun.file(lastMessagePath).text().catch(() => "")).trim();

      if (!content) {
        throw new Error("codex exec produced no final message.");
      }

      return {
        content,
        requestId: threadId ?? resumeId,
        usage: {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens
        }
      };
    }
  };
}

/**
 * The user messages since the last model response, joined — the harness holds
 * its own history via resume, so only new material is sent. Undefined when
 * there is nothing new: the previous reply stands and the turn should stop.
 */
function nextPrompt(input: ModelInput): string | undefined {
  const pending: string[] = [];
  let sawResponse = false;

  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;

    if (event.type === "model.response") {
      sawResponse = true;
      break;
    }

    if (event.type === "message.user") {
      pending.unshift(event.content);
    }
  }

  if (pending.length === 0) {
    return undefined;
  }

  // First contact: the agent's system prompt and instructions ride ahead of
  // the message, since a fresh harness session has no other way to get them.
  if (!sawResponse) {
    const preamble = [input.profile.systemPrompt, ...input.profile.skills]
      .filter(Boolean)
      .join("\n\n");

    return preamble ? `${preamble}\n\n${pending.join("\n\n")}` : pending.join("\n\n");
  }

  return pending.join("\n\n");
}

/** The harness session id recorded on the most recent turn, if any. */
function priorHarnessSession(input: ModelInput): string | undefined {
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;

    if (event.type === "model.response") {
      const requestId = (event.turn as { requestId?: unknown } | undefined)?.requestId;

      if (typeof requestId === "string" && requestId.length > 0) {
        return requestId;
      }
    }
  }

  return undefined;
}

async function run(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number }
): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  });
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `${argv[0]} exited ${exitCode}: ${truncate(stderr || stdout, 2000)}`
      );
    }

    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function lastJsonLine(stdout: string): string {
  const lines = stdout.split("\n").filter((line) => line.trim().startsWith("{"));
  const last = lines.at(-1);

  if (!last) {
    throw new Error(`Expected JSON output, got: ${truncate(stdout, 500)}`);
  }

  return last;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
