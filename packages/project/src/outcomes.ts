import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { outcomes } from "@oma/runtime";
import type { Outcome } from "@oma/runtime";
import { displayPath, outcomeJsonPath, outcomeMarkdownPath, validationReportPath } from "./paths";
import { readRunRecord, writeRunRecord } from "./run-index";
import type { ResolvedProject, RunRecord, ValidationReport } from "./types";

export async function writeOutcomeFiles(
  project: ResolvedProject,
  outcome: Outcome,
): Promise<RunRecord> {
  const jsonPath = outcomeJsonPath(project, outcome.runId);
  const markdownPath = outcomeMarkdownPath(project, outcome.runId);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(outcomes.toJson(outcome), null, 2)}\n`);
  await writeFile(markdownPath, outcomes.toMarkdown(outcome));

  const now = new Date().toISOString();
  const previous = await readRunRecord(project, outcome.runId);
  const record: RunRecord = {
    schemaVersion: 1,
    runId: outcome.runId,
    sessionId: outcome.events[0]?.sessionId ?? "",
    status: outcome.status,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    objective: outcome.objective.goal,
    outcomeJsonPath: displayPath(project, jsonPath),
    outcomeMarkdownPath: displayPath(project, markdownPath),
  };
  await writeRunRecord(project, record);
  return record;
}

export async function writeServerOutcomeFiles(
  project: ResolvedProject,
  outcome: Outcome,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const jsonPath = outcomeJsonPath(project, outcome.runId);
  const markdownPath = outcomeMarkdownPath(project, outcome.runId);
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(outcomes.toJson(outcome), null, 2)}\n`);
  await writeFile(markdownPath, outcomes.toMarkdown(outcome));
  return {
    jsonPath: displayPath(project, jsonPath),
    markdownPath: displayPath(project, markdownPath),
  };
}

export async function writeValidationReport(
  project: ResolvedProject,
  report: ValidationReport,
): Promise<string> {
  const path = validationReportPath(project, report.runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  return displayPath(project, path);
}
