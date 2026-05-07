import { hasChangedLine, parseChangedRightLines } from "./diff";
import { summaryMarker } from "./github";
import type {
  PullRequestContext,
  ReviewCommentPlan,
  ReviewFinding,
  ReviewFindingsArtifact,
  ReviewPolicy,
} from "./types";

export const defaultReviewPolicy: ReviewPolicy = {
  maxInlineComments: 10,
  inlineSeverity: ["blocking", "high"],
  inlineConfidence: ["high", "medium"],
  excludePaths: ["dist/**", "bun.lock", "package-lock.json"],
};

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    return path.startsWith(pattern.slice(0, -3));
  }
  return path === pattern;
}

function isExcluded(path: string, policy: ReviewPolicy): boolean {
  return policy.excludePaths.some((pattern) => matchesPattern(path, pattern));
}

function findingBody(finding: ReviewFinding): string {
  const evidence = finding.evidence.map((item) => `- ${item}`).join("\n");
  const suggestion = finding.suggestion ? `\n\nSuggested fix:\n\n${finding.suggestion}` : "";
  return [`**${finding.title}**`, "", finding.body, suggestion, "", "Evidence:", evidence].join(
    "\n",
  );
}

function skipReason(input: {
  finding: ReviewFinding;
  context: PullRequestContext;
  policy: ReviewPolicy;
  alreadyPlanned: number;
}): string | undefined {
  if (input.context.existingFindingIds.includes(input.finding.id)) {
    return "duplicate finding id";
  }
  if (isExcluded(input.finding.file, input.policy)) {
    return "excluded path";
  }
  if (!input.policy.inlineSeverity.includes(input.finding.severity)) {
    return "severity below inline threshold";
  }
  if (!input.policy.inlineConfidence.includes(input.finding.confidence)) {
    return "confidence below inline threshold";
  }
  if (!input.finding.line) {
    return "missing line";
  }
  if (input.finding.side !== "RIGHT") {
    return "left-side comments are not posted by this POC";
  }
  if (input.alreadyPlanned >= input.policy.maxInlineComments) {
    return "inline comment limit reached";
  }
  const diffIndex = parseChangedRightLines(input.context.diff);
  if (!hasChangedLine(diffIndex, input.finding.file, input.finding.line)) {
    return "line is not a changed right-side line";
  }
  return undefined;
}

export function planReviewComments(input: {
  context: PullRequestContext;
  artifact: ReviewFindingsArtifact;
  policy?: ReviewPolicy;
}): ReviewCommentPlan {
  const policy = input.policy ?? defaultReviewPolicy;
  const inline: ReviewCommentPlan["inline"] = [];
  const skipped: ReviewCommentPlan["skipped"] = [];

  for (const finding of input.artifact.findings) {
    const reason = skipReason({
      finding,
      context: input.context,
      policy,
      alreadyPlanned: inline.length,
    });
    if (reason) {
      skipped.push({
        findingId: finding.id,
        reason,
      });
      continue;
    }

    inline.push({
      findingId: finding.id,
      path: finding.file,
      line: finding.line as number,
      side: "RIGHT",
      body: findingBody(finding),
    });
  }

  const findingList =
    input.artifact.findings.length === 0
      ? "No high-signal findings."
      : input.artifact.findings
          .map((finding) => {
            const location = finding.line
              ? `${finding.file}:${String(finding.line)}`
              : finding.file;
            return `- <!-- oma-finding:${finding.id} -->${finding.severity}/${finding.confidence}: ${finding.title} (${location})`;
          })
          .join("\n");

  return {
    summary: {
      marker: summaryMarker,
      body: [
        summaryMarker,
        "",
        "## OMA PR Review",
        "",
        input.artifact.summary,
        "",
        "### Findings",
        "",
        findingList,
        "",
        `Inline comments planned: ${String(inline.length)}.`,
      ].join("\n"),
    },
    inline,
    skipped,
  };
}
