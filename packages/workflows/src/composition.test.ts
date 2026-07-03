import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadWorkflowDocument } from "./loader";

test("extends merges base workflows with the child winning field-by-field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-extends-"));
  writeFileSync(
    join(dir, "base.yml"),
    [
      "name: base",
      "agent: { prompt: base agent }",
      "stages:",
      "  execute:",
      "    prompt: Do the work.",
      "    output: { summary: string }",
      "  review:",
      "    agent: { prompt: base judge, model: base-judge }",
      "    prompt: Review it.",
      "    output:",
      '      verdict: approve | revise',
      "      feedback: string",
      "loop:",
      "  over: [execute, review]",
      "  until: review.verdict == approve",
      "  max: 5",
      "policy:",
      "  effects:",
      '    "*": deny',
      "    read_file: allow",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(dir, "child.yml"),
    [
      "name: child",
      "extends: base.yml",
      "stages:",
      "  review:",
      "    agent: { prompt: fancy judge, model: fancy-judge }",
      "policy:",
      "  effects:",
      "    post_review: allow",
      "  budget:",
      "    tokens: 1M",
      ""
    ].join("\n")
  );

  const loaded = await loadWorkflowDocument(join(dir, "child.yml"));

  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.workflow?.name).toBe("child");
  // Stage entries merge field-by-field; a declared agent is complete and
  // replaces the base's agent, while stage-level prompt/output survive.
  expect(loaded.workflow?.stages?.review).toMatchObject({
    prompt: "Review it.",
    output: { verdict: "approve | revise", feedback: "string" }
  });
  expect(loaded.agents?.stages.review?.model).toBe("fancy-judge");
  expect(loaded.agents?.stages.review?.profile.systemPrompt).toBe("fancy judge");
  expect(loaded.workflow?.stages?.execute?.prompt).toBe("Do the work.");
  expect(loaded.workflow?.loop?.until).toBe("review.verdict == approve");
  // Effects merge per pattern; budget arrives from the child.
  expect(loaded.workflow?.policy.effects).toEqual({
    "*": "deny",
    read_file: "allow",
    post_review: "allow"
  });
  expect(loaded.workflow?.policy.budget).toEqual({ tokens: "1M" });

  // A cycle is an error, not a hang.
  writeFileSync(join(dir, "a.yml"), "name: a\nextends: b.yml\nagent: { prompt: x }\nprompt: x\n");
  writeFileSync(join(dir, "b.yml"), "name: b\nextends: a.yml\nagent: { prompt: x }\nprompt: x\n");
  const cyclic = await loadWorkflowDocument(join(dir, "a.yml"));
  expect(cyclic.diagnostics.some((d) => d.code === "workflow.extends_cycle")).toBe(true);

  writeFileSync(
    join(dir, "orphan.yml"),
    "name: orphan\nextends: nowhere.yml\nagent: { prompt: x }\nprompt: x\n"
  );
  const orphan = await loadWorkflowDocument(join(dir, "orphan.yml"));
  expect(orphan.diagnostics.some((d) => d.code === "workflow.extends_missing")).toBe(true);
});

test("use pulls shared stage definitions with local fields overriding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-use-"));
  writeFileSync(
    join(dir, "stages.yml"),
    [
      "judge:",
      "  agent: { prompt: You judge strictly., model: claude-fable-5 }",
      "  prompt: Review the work strictly.",
      "  output:",
      '    verdict: approve | revise',
      "    feedback: string",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(dir, "workflow.yml"),
    [
      "name: uses-judge",
      "agent: { prompt: default agent }",
      "stages:",
      "  execute:",
      "    prompt: Build it.",
      "  review:",
      '    use: "stages.yml#judge"',
      "    approve: true",
      ""
    ].join("\n")
  );

  const loaded = await loadWorkflowDocument(join(dir, "workflow.yml"));

  expect(loaded.diagnostics).toEqual([]);
  // The library supplies prompt/output/agent; the local field overrides ride on top.
  expect(loaded.workflow?.stages?.review).toMatchObject({
    prompt: "Review the work strictly.",
    approve: true,
    output: { verdict: "approve | revise", feedback: "string" }
  });
  expect(loaded.agents?.stages.review?.model).toBe("claude-fable-5");

  writeFileSync(
    join(dir, "bad.yml"),
    'name: bad\nagent: { prompt: x }\nstages:\n  x:\n    use: "stages.yml#missing"\n    prompt: p\n'
  );
  const bad = await loadWorkflowDocument(join(dir, "bad.yml"));
  expect(bad.diagnostics.some((d) => d.code === "workflow.use_missing")).toBe(true);
});
