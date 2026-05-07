import type { Outcome } from "@oma/runtime";

export type TriggerSource = "fixture" | "issue_comment" | "pull_request" | "workflow_dispatch";

export type ReviewRequest = {
  repository: {
    owner: string;
    name: string;
    fullName: string;
  };
  pullRequest: {
    number: number;
    headSha: string;
    baseSha: string;
  };
  trigger: {
    source: TriggerSource;
    command: string;
    verbose: boolean;
  };
};

export type PullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type PullRequestContext = {
  request: ReviewRequest;
  title: string;
  body: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  files: PullRequestFile[];
  diff: string;
  existingSummaryCommentId?: number;
  existingFindingIds: string[];
};

export type ReviewSeverity = "blocking" | "high" | "medium" | "low";
export type ReviewConfidence = "high" | "medium" | "low";

export type ReviewFinding = {
  id: string;
  severity: ReviewSeverity;
  confidence: ReviewConfidence;
  file: string;
  line?: number;
  side: "RIGHT" | "LEFT";
  title: string;
  body: string;
  suggestion?: string;
  evidence: string[];
};

export type ReviewFindingsArtifact = {
  schemaVersion: 1;
  summary: string;
  findings: ReviewFinding[];
};

export type ReviewPolicy = {
  maxInlineComments: number;
  inlineSeverity: ReviewSeverity[];
  inlineConfidence: ReviewConfidence[];
  excludePaths: string[];
};

export type ReviewCommentPlan = {
  summary: {
    marker: string;
    body: string;
  };
  inline: Array<{
    findingId: string;
    path: string;
    line: number;
    side: "RIGHT" | "LEFT";
    body: string;
  }>;
  skipped: Array<{
    findingId: string;
    reason: string;
  }>;
};

export type ReviewRunResult = {
  outcome: Outcome;
  findings: ReviewFindingsArtifact;
  plan: ReviewCommentPlan;
};
