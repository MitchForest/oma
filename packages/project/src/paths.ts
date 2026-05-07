import { relative, resolve } from "node:path";
import type { ResolvedProject } from "./types";

function slash(path: string): string {
  return path.split("\\").join("/");
}

export function displayPath(project: ResolvedProject, path: string): string {
  return slash(relative(project.root, path));
}

export function runRecordPath(project: ResolvedProject, runId: string): string {
  return resolve(project.stateDir, "runs", `${runId}.json`);
}

export function outcomeJsonPath(project: ResolvedProject, runId: string): string {
  return resolve(project.stateDir, "outcomes", `${runId}.json`);
}

export function outcomeMarkdownPath(project: ResolvedProject, runId: string): string {
  return resolve(project.stateDir, "outcomes", `${runId}.md`);
}

export function validationReportPath(project: ResolvedProject, runId: string): string {
  return resolve(project.stateDir, "outcomes", `${runId}.validation.json`);
}
