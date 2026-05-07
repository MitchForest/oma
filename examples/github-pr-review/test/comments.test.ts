import { describe, expect, test } from "bun:test";
import { parseReviewLedger, planReviewComments } from "../src/comments";
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
    expect(plan.stats.newFindings).toBe(1);
    expect(plan.summary.body).toContain(".oma/pr-review-fix-prompts.md");
    expect(plan.summary.body).toContain("Still open: 0.");
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

  test("tracks resolved findings across reruns", () => {
    const firstPlan = planReviewComments({ context, artifact });
    const secondPlan = planReviewComments({
      context: {
        ...context,
        previousLedger: firstPlan.ledger,
      },
      artifact: {
        schemaVersion: 1,
        summary: "Clean.",
        findings: [],
      },
    });

    expect(secondPlan.stats.resolvedSinceLastRun).toBe(1);
    expect(secondPlan.summary.body).toContain("Resolved since last run: 1.");
    expect(parseReviewLedger(secondPlan.summary.body)?.findings[0]?.status).toBe("resolved");
  });

  test("does not repost inline comments for still-open ledger findings", () => {
    const firstPlan = planReviewComments({ context, artifact });
    const secondPlan = planReviewComments({
      context: {
        ...context,
        previousLedger: firstPlan.ledger,
      },
      artifact,
    });

    expect(secondPlan.inline).toHaveLength(0);
    expect(secondPlan.skipped[0]?.reason).toBe("duplicate open finding");
    expect(secondPlan.stats.stillOpen).toBe(1);
  });

  test("supports glob-style generated path exclusions", () => {
    const plan = planReviewComments({
      context,
      artifact: {
        ...artifact,
        findings: [
          {
            ...artifact.findings[0]!,
            file: "generated/client.ts",
          },
        ],
      },
      policy: {
        maxInlineComments: 10,
        inlineRisk: ["high"],
        inlineConfidence: ["high"],
        excludePaths: ["generated/**"],
      },
    });

    expect(plan.inline).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("excluded path");
  });
});
