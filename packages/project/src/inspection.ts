import { replayOutcome } from "@oma/runtime";
import type { Artifact, Outcome, Session, StoredEvent } from "@oma/runtime";
import { ProjectError } from "./errors";
import { createSessionStore } from "./factories";
import { readRunRecord } from "./run-index";
import type { ResolvedProject } from "./types";

export async function sessionForId(project: ResolvedProject, id: string): Promise<Session> {
  const store = createSessionStore(project);
  const record = await readRunRecord(project, id);
  return await store.open(record?.sessionId ?? id);
}

export async function localOutcome(project: ResolvedProject, id: string): Promise<Outcome> {
  const replayed = await replayOutcome(await sessionForId(project, id));
  if (!replayed.ok) {
    throw new ProjectError(`Run does not have a terminal outcome: ${replayed.reason}`);
  }
  return replayed.outcome;
}

export async function localEvents(project: ResolvedProject, id: string): Promise<StoredEvent[]> {
  return await (await sessionForId(project, id)).events();
}

export function artifactSummary(artifact: Artifact): {
  id: string;
  kind: string;
  name: string;
  mediaType: string;
  size: number;
} {
  return {
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    mediaType: artifact.mediaType,
    size: Buffer.byteLength(artifact.content, "utf8"),
  };
}
