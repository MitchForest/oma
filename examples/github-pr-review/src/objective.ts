import { objective } from "@oma/runtime";
import type { Objective } from "@oma/runtime";
import type { PullRequestContext } from "./types";

export function buildReviewObjective(context: PullRequestContext): Objective {
  const changedFiles = context.files
    .map((file) => `- ${file.filename} (${file.status})`)
    .join("\n");

  return objective({
    goal: [
      `Review pull request #${String(context.request.pullRequest.number)}: ${context.title}`,
      "",
      "Use the PR metadata and diff artifacts in `.oma` as the source of truth.",
      "Produce a concise review summary and structured findings for high-signal issues only.",
      "",
      "Changed files:",
      changedFiles || "- No changed files were reported.",
    ].join("\n"),
    constraints: [
      "Review only the PR changes unless surrounding context is necessary.",
      "Prioritize correctness, security, data loss, migrations, concurrency, test regressions, and user-visible regressions.",
      "Avoid style-only, speculative, or preference comments.",
      "Only report findings that are actionable and grounded in file/line evidence.",
      "Do not run destructive commands.",
      "Do not expose secrets in artifacts, logs, or comments.",
    ],
    success: [
      "Write `.oma/pr-review-summary.md` with a concise PR walkthrough and verdict.",
      "Write `.oma/pr-review-findings.json` using schemaVersion 1 with summary and findings.",
      "Write `.oma/pr-review-findings.md` as a readable findings report.",
      "Each finding includes risk, confidence, category, file, line, title, body, why it matters, evidence, suggested fix, and validation.",
    ],
  });
}
