import { FakeModelProvider } from "@oma/adapter-model-fake";
import type { ModelProvider } from "@oma/core";

/**
 * Deterministic models for the staged issue-to-pr demo. FakeModelProvider
 * indexes its script by the session's recorded model.response count, so the
 * same cumulative script serves every wake of a durable stage session —
 * iteration one of the judge returns revise, iteration two approves.
 */

function jsonReply(value: Record<string, unknown>, prose: string) {
  return [
    { content: `${prose}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`` },
    { finishReason: "done" as const }
  ];
}

export function createPlannerModel(): ModelProvider {
  return new FakeModelProvider(
    jsonReply(
      { summary: "Add input validation to the session key resolver and cover it with a test." },
      "I inspected the issue and drafted a minimal plan."
    )
  );
}

export function createCoderModel(): ModelProvider {
  return new FakeModelProvider([
    ...jsonReply(
      { summary: "Added validation to resolveSessionKey; new unit test for empty keys." },
      "Implemented the plan."
    ),
    ...jsonReply(
      { summary: "Added the missing regression test for interpolated keys and fixed the error message." },
      "Addressed the reviewer feedback."
    )
  ]);
}

/**
 * Effects-policy demo: tries a denied tool, then an approve-gated one. The
 * denial comes back as a tool error the model can read; the gated call pauses
 * the run until `oma approve`/`oma deny`.
 */
export function createEffectsDemoModel(): ModelProvider {
  return new FakeModelProvider([
    { toolCalls: [{ name: "bash", args: { command: "rm", args: ["-rf", "important/"] } }] },
    {
      toolCalls: [
        { name: "write_file", args: { path: "notes.txt", content: "hello from the workflow" } }
      ]
    },
    { content: "Finished: the cleanup was denied by policy; the note awaited approval." },
    { finishReason: "done" }
  ]);
}

/** Budget demo: each turn reports heavy token usage so a small budget trips. */
export function createBudgetDemoModel(): ModelProvider {
  return new FakeModelProvider([
    { content: "Thinking hard.", usage: { inputTokens: 800, outputTokens: 200 } },
    { content: "Thinking harder.", usage: { inputTokens: 800, outputTokens: 200 } },
    { content: "Still thinking.", usage: { inputTokens: 800, outputTokens: 200 } },
    { finishReason: "done" }
  ]);
}

/** Secrets demo: reads an exposed secret from the sandbox environment. */
export function createEnvDemoModel(): ModelProvider {
  return new FakeModelProvider([
    { toolCalls: [{ name: "bash", args: { command: "printenv", args: ["DEMO_SECRET"] } }] },
    { content: "Printed the exposed secret." },
    { finishReason: "done" }
  ]);
}

export function createJudgeModel(): ModelProvider {
  return new FakeModelProvider([
    ...jsonReply(
      {
        verdict: "revise",
        feedback: "The error-path change has no regression test for interpolated keys."
      },
      "Reviewed the implementation against the plan."
    ),
    ...jsonReply(
      { verdict: "approve", feedback: "All plan items are covered and tested." },
      "Re-reviewed after the revision."
    )
  ]);
}
