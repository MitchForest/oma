import type { Artifact, Outcome, OutcomeJsonV1, StoredEvent } from "@oma/runtime";
import { outcomes } from "@oma/runtime";
import type { ServerRunRecord } from "./types";

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export function emptyResponse(init: ResponseInit = {}): Response {
  return new Response(null, init);
}

export function runResponse(run: ServerRunRecord): Record<string, unknown> {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    objective: run.objective,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    outcomeJsonPath: run.outcomeJsonPath,
    outcomeMarkdownPath: run.outcomeMarkdownPath,
    error: run.error,
  };
}

export function outcomeResponse(outcome: Outcome): OutcomeJsonV1 {
  return outcomes.toJson(outcome);
}

export function eventResponse(events: StoredEvent[]): StoredEvent[] {
  return events;
}

export function artifactsResponse(artifacts: Artifact[]): Array<{
  id: string;
  kind: string;
  name: string;
  mediaType: string;
  size: number;
}> {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    name: artifact.name,
    mediaType: artifact.mediaType,
    size: Buffer.byteLength(artifact.content, "utf8"),
  }));
}
