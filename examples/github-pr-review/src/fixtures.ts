import { readFile } from "node:fs/promises";
import type {
  PullRequestContext,
  PullRequestFile,
  ReviewFindingsArtifact,
  ReviewRequest,
} from "./types";

function readObject<T>(value: string, label: string): T {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as T;
}

export async function loadFixtureContext(input: {
  fixtureDir: string;
  request: ReviewRequest;
}): Promise<PullRequestContext> {
  const metadata = readObject<{
    title: string;
    body: string;
    author: string;
    baseBranch: string;
    headBranch: string;
    files: PullRequestFile[];
    existingFindingIds?: string[];
  }>(await readFile(`${input.fixtureDir}/metadata.json`, "utf8"), "metadata");
  const diff = await readFile(`${input.fixtureDir}/diff.patch`, "utf8");

  return {
    request: input.request,
    title: metadata.title,
    body: metadata.body,
    author: metadata.author,
    baseBranch: metadata.baseBranch,
    headBranch: metadata.headBranch,
    files: metadata.files,
    diff,
    existingFindingIds: metadata.existingFindingIds ?? [],
  };
}

export async function loadFixtureFindings(fixtureDir: string): Promise<ReviewFindingsArtifact> {
  return readObject<ReviewFindingsArtifact>(
    await readFile(`${fixtureDir}/findings.json`, "utf8"),
    "findings",
  );
}
