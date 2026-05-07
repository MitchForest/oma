import { replayOutcome } from "@oma/runtime";
import type { Objective } from "@oma/runtime";
import { createServerSessionStore, writeValidationReport } from "@oma/project";
import type { ResolvedProject } from "@oma/project";
import { createEventBus, sseStream } from "./events";
import { HttpError, messageFrom } from "./errors";
import { createId } from "./ids";
import {
  artifactsResponse,
  emptyResponse,
  eventResponse,
  jsonResponse,
  outcomeResponse,
  runResponse,
} from "./responses";
import { createServerStore } from "./store";
import type { ServerStore } from "./store";
import { createWorker, rerunValidation } from "./worker";
import type { Worker } from "./worker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObjective(value: unknown): Objective {
  if (!isRecord(value)) {
    throw new HttpError(400, "Request field objective is required.");
  }

  const goal = value.goal;
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new HttpError(400, "Request field objective.goal is required.");
  }

  const constraints = value.constraints;
  const success = value.success;

  return {
    goal,
    constraints: Array.isArray(constraints)
      ? constraints.filter((item): item is string => typeof item === "string")
      : [],
    success: Array.isArray(success)
      ? success.filter((item): item is string => typeof item === "string")
      : [],
  };
}

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function pathParts(request: Request): string[] {
  return new URL(request.url).pathname.split("/").filter(Boolean);
}

export type OmaApp = {
  fetch(request: Request): Promise<Response>;
  startWorker(): void;
  stopWorker(): void;
  drain(): Promise<void>;
  close(): void;
};

export async function createOmaApp(input: {
  config: ResolvedProject;
  autoStartWorker?: boolean;
}): Promise<OmaApp> {
  const store = await createServerStore(input.config.databasePath);
  const events = createEventBus();
  const worker = createWorker({
    config: input.config,
    store,
    events,
  });

  if (input.autoStartWorker ?? true) {
    worker.start();
  }

  return createApp({
    autoStartWorker: input.autoStartWorker ?? true,
    config: input.config,
    store,
    worker,
    events,
  });
}

function createApp(input: {
  autoStartWorker: boolean;
  config: ResolvedProject;
  store: ServerStore;
  worker: Worker;
  events: ReturnType<typeof createEventBus>;
}): OmaApp {
  const sessionStore = createServerSessionStore(input.config);

  async function sessionOutcome(runId: string) {
    const record = input.store.getRun(runId);
    if (!record) {
      throw new HttpError(404, `Run not found: ${runId}`);
    }
    const session = await sessionStore.open(record.sessionId);
    const replayed = await replayOutcome(session);
    if (!replayed.ok) {
      throw new HttpError(409, `Run does not have a terminal outcome: ${replayed.reason}`);
    }
    return replayed.outcome;
  }

  async function handle(request: Request): Promise<Response> {
    const parts = pathParts(request);

    if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && parts.length === 1 && parts[0] === "runs") {
      const body = await jsonBody(request);
      const objective = parseObjective(isRecord(body) ? body.objective : undefined);
      const runId = createId("run");
      const session = await sessionStore.create();
      const record = input.store.createRun({
        runId,
        sessionId: session.id,
        objective,
      });
      if (input.autoStartWorker) {
        input.worker.start();
      }
      return jsonResponse(runResponse(record), { status: 202 });
    }

    if (request.method === "GET" && parts.length === 1 && parts[0] === "runs") {
      return jsonResponse({
        runs: input.store.listRuns().map(runResponse),
      });
    }

    if (parts[0] !== "runs" || !parts[1]) {
      throw new HttpError(404, "Route not found.");
    }

    const runId = parts[1];
    const record = input.store.getRun(runId);
    if (!record) {
      throw new HttpError(404, `Run not found: ${runId}`);
    }

    if (request.method === "GET" && parts.length === 2) {
      return jsonResponse(runResponse(record));
    }

    if (request.method === "GET" && parts.length === 3 && parts[2] === "events") {
      const session = await sessionStore.open(record.sessionId);
      return jsonResponse({
        events: eventResponse(await session.events()),
      });
    }

    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[2] === "events" &&
      parts[3] === "stream"
    ) {
      const session = await sessionStore.open(record.sessionId);
      return sseStream({
        existing: await session.events(),
        follow:
          record.status === "queued" ||
          record.status === "running" ||
          record.status === "cancel_requested"
            ? input.events.subscribe(runId)
            : terminalStream(record.status),
      });
    }

    if (request.method === "GET" && parts.length === 3 && parts[2] === "outcome") {
      return jsonResponse(outcomeResponse(await sessionOutcome(runId)));
    }

    if (request.method === "GET" && parts.length === 3 && parts[2] === "artifacts") {
      return jsonResponse({
        artifacts: artifactsResponse((await sessionOutcome(runId)).artifacts),
      });
    }

    if (request.method === "GET" && parts.length === 4 && parts[2] === "artifacts" && parts[3]) {
      const outcome = await sessionOutcome(runId);
      const artifact = outcome.artifacts.find((item) => item.id === parts[3]);
      if (!artifact) {
        throw new HttpError(404, `Artifact not found: ${parts[3]}`);
      }
      return new Response(artifact.content, {
        headers: {
          "content-type": `${artifact.mediaType}; charset=utf-8`,
        },
      });
    }

    if (request.method === "POST" && parts.length === 3 && parts[2] === "validate") {
      const outcome = await sessionOutcome(runId);
      const report = await rerunValidation({
        config: input.config,
        runId,
        outcome,
      });
      const path = await writeValidationReport(input.config, report);
      return jsonResponse({
        ...report,
        path,
      });
    }

    if (request.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
      if (record.status === "queued") {
        input.store.markCancelled(runId);
        return jsonResponse(runResponse(input.store.getRun(runId) ?? record));
      }
      if (record.status === "running") {
        throw new HttpError(409, "Running cancellation requires runtime abort support.");
      }
      throw new HttpError(409, `Cannot cancel run with status ${record.status}.`);
    }

    return emptyResponse({ status: 404 });
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return jsonResponse(
          {
            error: {
              message: messageFrom(error),
            },
          },
          { status },
        );
      }
    },

    startWorker() {
      input.worker.start();
    },

    stopWorker() {
      input.worker.stop();
    },

    async drain() {
      await input.worker.drain();
    },

    close() {
      input.worker.stop();
      input.store.close();
    },
  };
}

async function* terminalStream(status: string) {
  yield {
    type: "oma.done" as const,
    data: {
      status,
    },
  };
}
