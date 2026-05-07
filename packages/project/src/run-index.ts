import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ProjectError } from "./errors";
import { runRecordPath } from "./paths";
import type { ResolvedProject, RunRecord } from "./types";

export async function writeRunRecord(project: ResolvedProject, record: RunRecord): Promise<void> {
  const path = runRecordPath(project, record.runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

export async function readRunRecord(
  project: ResolvedProject,
  runId: string,
): Promise<RunRecord | undefined> {
  try {
    return JSON.parse(await readFile(runRecordPath(project, runId), "utf8")) as RunRecord;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function requireRunRecord(
  project: ResolvedProject,
  runId: string,
): Promise<RunRecord> {
  const record = await readRunRecord(project, runId);
  if (!record) {
    throw new ProjectError(`Run not found: ${runId}`);
  }
  return record;
}

export async function listRunRecords(project: ResolvedProject): Promise<RunRecord[]> {
  try {
    const files = await readdir(resolve(project.stateDir, "runs"));
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const content = await readFile(resolve(project.stateDir, "runs", file), "utf8");
          return JSON.parse(content) as RunRecord;
        }),
    );
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
