import { describe, expect, test } from "bun:test";
import { planReviewComments } from "../src/comments";
import type { PullRequestContext, ReviewFindingsArtifact } from "../src/types";

const context: PullRequestContext = {
  request: {
    repository: {
      owner: "oma",
      name: "example",
      fullName: "oma/example",
    },
    pullRequest: {
      number: 1,
      baseSha: "a",
      headSha: "b",
    },
    trigger: {
      source: "fixture",
      command: "oma review",
      verbose: false,
    },
  },
  title: "Example",
  body: "",
  author: "mitch",
  baseBranch: "main",
  headBranch: "branch",
  files: [],
  diff: [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,3 @@",
    " const value = 1;",
    "+dangerousCall();",
    " export {};",
  ].join("\n"),
  existingFindingIds: [],
};

const artifact: ReviewFindingsArtifact = {
  schemaVersion: 1,
  summary: "One finding.",
  findings: [
    {
      id: "dangerous-call",
      risk: "high",
      confidence: "high",
      category: "logic_error",
      file: "src/app.ts",
      line: 2,
      side: "RIGHT",
      title: "Dangerous call is unconditional",
      body: "This newly added call has no guard.",
      whyItMatters: "The changed behavior can execute a side effect on every call path.",
      suggestedFix: "Guard the call behind the intended condition.",
      evidence: ["Line 2 is added in the PR diff."],
      validation: ["Add a test for the guarded path."],
    },
  ],
};

describe("comment planning", () => {
  test("plans inline comments for high-confidence changed lines", () => {
    const plan = planReviewComments({ context, artifact });
    expect(plan.inline).toHaveLength(1);
    expect(plan.inline[0]?.path).toBe("src/app.ts");
    expect(plan.inline[0]?.line).toBe(2);
  });

  test("suppresses duplicate finding ids", () => {
    const plan = planReviewComments({
      context: {
        ...context,
        existingFindingIds: ["dangerous-call"],
      },
      artifact,
    });
    expect(plan.inline).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("duplicate finding id");
  });
});
