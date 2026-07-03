import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ModelInput, SessionEvent } from "@oma/core";
import { defineProfile } from "@oma/core";
import { createClaudeCodeModel, createCodexModel } from "./index";

const profile = defineProfile({
  name: "cli-test",
  mode: "automation",
  systemPrompt: "You are the executor.",
  skills: ["Extra instructions."],
  tools: [],
  sandboxPolicy: { kind: "local" },
  modelDefaults: {},
  policy: { toolError: "continue" }
});

function modelInput(events: Array<Record<string, unknown>>): ModelInput {
  return {
    events: events.map((event, offset) => ({
      id: `e${offset}`,
      sessionId: "s1",
      offset,
      createdAt: new Date().toISOString(),
      ...event
    })) as SessionEvent[],
    profile,
    context: { events: [], truncated: false },
    tools: []
  } as unknown as ModelInput;
}

test("claude-code provider sends new messages, resumes, and stops when idle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-claude-stub-"));
  const argsLog = join(dir, "args.log");
  const stub = join(dir, "claude");

  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${argsLog}"
echo '{"type":"result","is_error":false,"result":"stub reply","session_id":"sid-123","usage":{"input_tokens":10,"output_tokens":5}}'
`
  );
  chmodSync(stub, 0o755);

  const model = createClaudeCodeModel({ binary: stub, model: "claude-opus-4-8" });

  // First turn: system prompt + instructions ride ahead of the user message.
  const first = await model.turn(
    modelInput([{ type: "message.user", content: "Build the feature." }])
  );

  expect(first.content).toBe("stub reply");
  expect(first.requestId).toBe("sid-123");
  expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

  const firstLog = await Bun.file(argsLog).text();
  const firstArgs = firstLog.split("\n");
  expect(firstLog).toContain("You are the executor.");
  expect(firstLog).toContain("Extra instructions.");
  expect(firstLog).toContain("Build the feature.");
  expect(firstArgs).toContain("--model");
  expect(firstArgs).toContain("claude-opus-4-8");
  expect(firstArgs).toContain("--dangerously-skip-permissions");
  expect(firstArgs).not.toContain("--resume");

  // No new user message since the reply: the turn stops without a subprocess.
  const idle = await model.turn(
    modelInput([
      { type: "message.user", content: "Build the feature." },
      { type: "model.response", turn: { content: "stub reply", requestId: "sid-123" } },
      { type: "message.assistant", content: "stub reply" }
    ])
  );
  expect(idle.finishReason).toBe("stop");

  // A follow-up message resumes the recorded harness session with ONLY the
  // new material (no repeated system prompt).
  await Bun.write(argsLog, "");
  const second = await model.turn(
    modelInput([
      { type: "message.user", content: "Build the feature." },
      { type: "model.response", turn: { content: "stub reply", requestId: "sid-123" } },
      { type: "message.assistant", content: "stub reply" },
      { type: "message.user", content: "Reviewer feedback: add tests." }
    ])
  );

  expect(second.content).toBe("stub reply");

  const secondLog = await Bun.file(argsLog).text();
  const secondArgs = secondLog.split("\n");
  expect(secondArgs).toContain("--resume");
  expect(secondArgs).toContain("sid-123");
  expect(secondArgs[1]).toBe("Reviewer feedback: add tests.");
  expect(secondLog).not.toContain("You are the executor.");
});

test("codex provider parses JSONL, reads the last message, and threads resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-codex-stub-"));
  const argsLog = join(dir, "args.log");
  const stub = join(dir, "codex");

  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${argsLog}"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
echo 'from codex stub' > "$out"
echo '{"type":"thread.started","thread_id":"thread-9"}'
echo '{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":7}}'
`
  );
  chmodSync(stub, 0o755);

  const model = createCodexModel({
    binary: stub,
    model: "gpt-5.5",
    effort: "medium"
  });
  const first = await model.turn(
    modelInput([{ type: "message.user", content: "Build the feature." }])
  );

  expect(first.content).toBe("from codex stub");
  expect(first.requestId).toBe("thread-9");
  expect(first.usage).toEqual({ inputTokens: 20, outputTokens: 7 });

  const firstArgs = (await Bun.file(argsLog).text()).split("\n");
  expect(firstArgs[0]).toBe("exec");
  expect(firstArgs).toContain("-m");
  expect(firstArgs).toContain("gpt-5.5");
  expect(firstArgs).toContain('model_reasoning_effort="medium"');
  expect(firstArgs).toContain("workspace-write");
  expect(firstArgs).not.toContain("resume");

  await Bun.write(argsLog, "");
  await model.turn(
    modelInput([
      { type: "message.user", content: "Build the feature." },
      { type: "model.response", turn: { content: "from codex stub", requestId: "thread-9" } },
      { type: "message.assistant", content: "from codex stub" },
      { type: "message.user", content: "Fix the tests." }
    ])
  );

  const secondArgs = (await Bun.file(argsLog).text()).split("\n");
  expect(secondArgs[0]).toBe("exec");
  expect(secondArgs[1]).toBe("resume");
  expect(secondArgs[2]).toBe("thread-9");
});

test("cli failures surface as errors with the tool named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-fail-stub-"));
  const stub = join(dir, "claude");

  writeFileSync(stub, `#!/bin/sh\necho "boom" >&2\nexit 3\n`);
  chmodSync(stub, 0o755);

  const model = createClaudeCodeModel({ binary: stub });

  await expect(
    model.turn(modelInput([{ type: "message.user", content: "go" }]))
  ).rejects.toThrow("exited 3");
});
