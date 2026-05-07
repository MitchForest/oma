import { describe, expect, test } from "bun:test";
import {
  parseFindingsArtifact,
  renderFindingsMarkdown,
  renderFixPromptsMarkdown,
} from "../src/findings";
import type { ReviewFinding, ReviewFindingsArtifact } from "../src/types";

function finding(input: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: input.id ?? "hidden-fallback",
    risk: input.risk ?? "high",
    confidence: input.confidence ?? "high",
    category: input.category ?? "hidden_path",
    file: input.file ?? "src/config.ts",
    line: input.line ?? 12,
    side: input.side ?? "RIGHT",
    title: input.title ?? "Silent fallback hides missing configuration",
    body:
      input.body ?? "The changed line falls back to a default value instead of failing clearly.",
    whyItMatters:
      input.whyItMatters ??
      "Hidden paths make production failures hard to diagnose and can leave invalid state running.",
    suggestedFix:
      input.suggestedFix ?? "Return an explicit configuration error when the value is absent.",
    evidence: input.evidence ?? [
      "The added line uses `?? defaultValue` on required configuration.",
    ],
    validation: input.validation ?? ["Add a test for missing required configuration."],
  };
}

describe("findings schema", () => {
  test("accepts product-grade AI slop categories", () => {
    const artifact: ReviewFindingsArtifact = {
      schemaVersion: 1,
      summary: "Three risks found.",
      findings: [
        finding(),
        finding({
          id: "compat-shim",
          risk: "medium",
          category: "unnecessary_shim",
          title: "Compatibility shim has no removal path",
        }),
        finding({
          id: "breaking-db-change",
          category: "database_migration",
          title: "Migration changes stored shape without a rollback plan",
        }),
      ],
    };

    const parsed = parseFindingsArtifact(JSON.stringify(artifact));
    expect(parsed.findings.map((item) => item.category)).toEqual([
      "hidden_path",
      "unnecessary_shim",
      "database_migration",
    ]);
  });

  test("renders no-findings reviews cleanly", () => {
    const markdown = renderFindingsMarkdown({
      schemaVersion: 1,
      summary: "No high-signal findings.",
      findings: [],
    });

    expect(markdown).toContain("No findings.");
  });

  test("renders agent-ready fix handoff prompts", () => {
    const markdown = renderFixPromptsMarkdown({
      schemaVersion: 1,
      summary: "One fix needed.",
      findings: [finding()],
    });

    expect(markdown).toContain("# PR Review Fix Handoff");
    expect(markdown).toContain("## hidden-fallback: Silent fallback hides missing configuration");
    expect(markdown).toContain("Minimal fix objective:");
    expect(markdown).toContain(
      "Fix silent fallback hides missing configuration at src/config.ts:12.",
    );
    expect(markdown).toContain("Return an explicit configuration error when the value is absent.");
    expect(markdown).toContain("Suggested validation:");
    expect(markdown).toContain("- Add a test for missing required configuration.");
  });
});
