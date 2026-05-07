import { hasChangedLine, parseChangedRightLines } from "./diff";
import { summaryMarker } from "./markers";
import type {
  PullRequestContext,
  ReviewCommentPlan,
  ReviewFinding,
  ReviewFindingsArtifact,
  ReviewLedger,
  ReviewLedgerFinding,
  ReviewLedgerStats,
  ReviewPolicy,
} from "./types";

const ledgerMarkerStart = "<!-- oma-pr-review:ledger";
const ledgerMarkerEnd = "oma-pr-review:ledger -->";

export const defaultReviewPolicy: ReviewPolicy = {
  maxInlineComments: 10,
  inlineRisk: ["high"],
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

function findingFingerprint(finding: ReviewFinding): string {
  return [finding.file, String(finding.line), finding.category, finding.title]
    .join("\u001f")
    .toLowerCase();
}

function findingBody(finding: ReviewFinding): string {
  const evidence = finding.evidence.map((item) => `- ${item}`).join("\n");
  const validation = finding.validation.map((item) => `- ${item}`).join("\n");
  return [
    `**${finding.title}**`,
    "",
    `Risk: ${finding.risk}`,
    `Category: ${finding.category}`,
    "",
    finding.body,
    "",
    "Why it matters:",
    finding.whyItMatters,
    "",
    "Suggested fix:",
    finding.suggestedFix,
    "",
    "Evidence:",
    evidence,
    "",
    "Validation:",
    validation,
  ].join("\n");
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
  if (
    input.context.previousLedger?.findings.some(
      (finding) =>
        finding.status === "open" && finding.fingerprint === findingFingerprint(input.finding),
    )
  ) {
    return "duplicate open finding";
  }
  if (isExcluded(input.finding.file, input.policy)) {
    return "excluded path";
  }
  if (!input.policy.inlineRisk.includes(input.finding.risk)) {
    return "risk below inline threshold";
  }
  if (!input.policy.inlineConfidence.includes(input.finding.confidence)) {
    return "confidence below inline threshold";
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

function buildLedger(input: {
  context: PullRequestContext;
  artifact: ReviewFindingsArtifact;
  skippedCount: number;
  inlineCount: number;
}): {
  ledger: ReviewLedger;
  stats: ReviewLedgerStats;
} {
  const now = new Date().toISOString();
  const previous = input.context.previousLedger;
  const previousOpen = new Map(
    (previous?.findings ?? [])
      .filter((finding) => finding.status === "open")
      .map((finding) => [finding.fingerprint, finding]),
  );
  const currentFingerprints = new Set<string>();
  const findings: ReviewLedgerFinding[] = [];
  let newFindings = 0;
  let stillOpen = 0;

  for (const finding of input.artifact.findings) {
    const fingerprint = findingFingerprint(finding);
    currentFingerprints.add(fingerprint);
    const existing = previousOpen.get(fingerprint);
    if (existing) {
      stillOpen += 1;
    } else {
      newFindings += 1;
    }
    findings.push({
      fingerprint,
      findingId: finding.id,
      title: finding.title,
      file: finding.file,
      line: finding.line,
      risk: finding.risk,
      category: finding.category,
      status: "open",
      firstSeenHeadSha: existing?.firstSeenHeadSha ?? input.context.request.pullRequest.headSha,
      lastSeenHeadSha: input.context.request.pullRequest.headSha,
    });
  }

  let resolvedSinceLastRun = 0;
  for (const finding of previous?.findings ?? []) {
    if (finding.status !== "open" || currentFingerprints.has(finding.fingerprint)) {
      continue;
    }
    resolvedSinceLastRun += 1;
    findings.push({
      ...finding,
      status: "resolved",
      lastSeenHeadSha: input.context.request.pullRequest.headSha,
      resolvedAt: now,
    });
  }

  const ledger: ReviewLedger = {
    schemaVersion: 1,
    runNumber: (previous?.runNumber ?? 0) + 1,
    headSha: input.context.request.pullRequest.headSha,
    updatedAt: now,
    findings,
  };

  return {
    ledger,
    stats: {
      newFindings,
      stillOpen,
      resolvedSinceLastRun,
      suppressed: input.skippedCount,
      inlinePosted: input.inlineCount,
      totalOpen: findings.filter((finding) => finding.status === "open").length,
    },
  };
}

function ledgerComment(ledger: ReviewLedger): string {
  return `${ledgerMarkerStart}\n${JSON.stringify(ledger)}\n${ledgerMarkerEnd}`;
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

  const { ledger, stats } = buildLedger({
    context: input.context,
    artifact: input.artifact,
    skippedCount: skipped.length,
    inlineCount: inline.length,
  });
  const findingList =
    input.artifact.findings.length === 0
      ? "No high-signal findings."
      : input.artifact.findings
          .map((finding) => {
            const location = `${finding.file}:${String(finding.line)}`;
            return `- <!-- oma-finding:${finding.id} -->${finding.risk}/${finding.confidence}/${finding.category}: ${finding.title} (${location})`;
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
        "### Lifecycle",
        "",
        `New: ${String(stats.newFindings)}.`,
        `Still open: ${String(stats.stillOpen)}.`,
        `Resolved since last run: ${String(stats.resolvedSinceLastRun)}.`,
        `Suppressed: ${String(stats.suppressed)}.`,
        `Inline comments planned: ${String(stats.inlinePosted)}.`,
        "",
        ledgerComment(ledger),
      ].join("\n"),
    },
    ledger,
    stats,
    inline,
    skipped,
  };
}

export function parseReviewLedger(body: string): ReviewLedger | undefined {
  const start = body.indexOf(ledgerMarkerStart);
  if (start < 0) {
    return undefined;
  }
  const jsonStart = body.indexOf("\n", start);
  const end = body.indexOf(ledgerMarkerEnd, jsonStart);
  if (jsonStart < 0 || end < 0) {
    return undefined;
  }
  const parsed = JSON.parse(body.slice(jsonStart + 1, end).trim()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as ReviewLedger;
  if (record.schemaVersion !== 1 || !Array.isArray(record.findings)) {
    return undefined;
  }
  return record;
}

export function renderInProgressSummary(input: {
  context: PullRequestContext;
  runUrl?: string | undefined;
}): string {
  return [
    summaryMarker,
    "",
    "## OMA PR Review",
    "",
    "Review in progress.",
    "",
    "### Lifecycle",
    "",
    `Head: ${input.context.request.pullRequest.headSha}`,
    input.runUrl ? `Run: ${input.runUrl}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
