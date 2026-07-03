import {
  deriveSessionStatus,
  deriveSessionView,
  hasSessionProjections,
  type ForkSummary,
  type SessionRecord,
  type SessionStore,
  type SessionSummary
} from "@oma/core";
import { appHtml } from "./ui-html";

export interface UiServer {
  port: number;
  stop(): void;
}

export interface UiServerOptions {
  store: SessionStore;
  port?: number;
  hostname?: string;
  sendMessage(
    sessionId: string,
    message: string,
    options?: { wake?: boolean }
  ): Promise<unknown>;
  wakeSession(sessionId: string): Promise<unknown>;
  forkSession(sessionId: string, atOffset: number): Promise<string>;
}

interface SessionPayload {
  session: SessionRecord;
  status: string;
  view: ReturnType<typeof deriveSessionView>;
  forks: ForkSummary[];
}

interface UiSessionSummary extends SessionSummary {
  trigger?: {
    source: string;
    kind: string;
  };
  forkedFrom?: {
    sessionId: string;
    atOffset: number;
  };
}

export function createUiServer(options: UiServerOptions): UiServer {
  const server = Bun.serve({
    port: options.port ?? 8788,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: (request) => handleRequest(request, options)
  });

  return {
    port: server.port ?? options.port ?? 8788,
    stop() {
      server.stop(true);
    }
  };
}

async function handleRequest(request: Request, options: UiServerOptions): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && (url.pathname === "/" || parts[0] === "sessions")) {
      return htmlResponse(appHtml());
    }

    if (parts[0] !== "api") {
      return notFound();
    }

    if (request.method === "GET" && parts[1] === "sessions" && parts.length === 2) {
      return jsonResponse(await listSessions(options.store));
    }

    if (parts[1] !== "sessions" || !parts[2]) {
      return notFound();
    }

    const sessionId = decodeURIComponent(parts[2]);
    const action = parts[3];

    if (request.method === "GET" && !action) {
      return jsonResponse(await projectSession(options.store, sessionId));
    }

    if (request.method === "GET" && action === "events") {
      const session = await options.store.getSession(sessionId);
      return jsonResponse(session.events);
    }

    if (request.method === "GET" && action === "forks") {
      return jsonResponse(await listForks(options.store, sessionId));
    }

    if (request.method === "GET" && action === "stream") {
      const fromOffset = Number(url.searchParams.get("fromOffset") ?? "0");
      return streamEvents(options.store, sessionId, Number.isFinite(fromOffset) ? fromOffset : 0);
    }

    if (request.method === "POST" && action === "send") {
      const body = await readJsonObject(request);
      const message = readString(body, "message");

      if (!message) {
        return jsonResponse({ error: "message is required" }, 400);
      }

      const result = await options.sendMessage(sessionId, message, {
        wake: readBoolean(body, "wake") ?? true
      });

      return jsonResponse({ result, session: await projectSession(options.store, sessionId) });
    }

    if (request.method === "POST" && action === "wake") {
      const result = await options.wakeSession(sessionId);
      return jsonResponse({ result, session: await projectSession(options.store, sessionId) });
    }

    if (request.method === "POST" && action === "fork") {
      const body = await readJsonObject(request);
      const offset = readNumber(body, "offset");

      if (offset === undefined) {
        return jsonResponse({ error: "offset is required" }, 400);
      }

      const forkId = await options.forkSession(sessionId, offset);
      return jsonResponse({ forkId });
    }

    return notFound();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /^session not found/i.test(message) ? 404 : 500;
    return jsonResponse({ error: message }, status);
  }
}

function listSessions(store: SessionStore): Promise<UiSessionSummary[]> {
  if (!hasSessionProjections(store)) {
    throw new Error("Configured store does not support session projections");
  }

  // Badges come from the summary metadata the trigger router and fork
  // commands record — no per-session event-log reads.
  return store.listSessions().then((summaries) =>
    summaries.map((summary) => ({
      ...summary,
      trigger: triggerFromMetadata(summary.metadata),
      forkedFrom: forkedFromMetadata(summary.metadata)
    }))
  );
}

function triggerFromMetadata(
  metadata: Record<string, unknown> | undefined
): UiSessionSummary["trigger"] {
  const trigger = metadata?.trigger;

  if (typeof trigger !== "string") {
    return undefined;
  }

  const separator = trigger.indexOf(":");

  if (separator <= 0 || separator === trigger.length - 1) {
    return undefined;
  }

  return {
    source: trigger.slice(0, separator),
    kind: trigger.slice(separator + 1)
  };
}

function forkedFromMetadata(
  metadata: Record<string, unknown> | undefined
): UiSessionSummary["forkedFrom"] {
  const forkedFrom = metadata?.forkedFrom;

  if (!forkedFrom || typeof forkedFrom !== "object") {
    return undefined;
  }

  const { sessionId, atOffset } = forkedFrom as Record<string, unknown>;

  if (typeof sessionId !== "string" || typeof atOffset !== "number") {
    return undefined;
  }

  return { sessionId, atOffset };
}

async function listForks(store: SessionStore, sessionId: string): Promise<ForkSummary[]> {
  if (!hasSessionProjections(store)) {
    return [];
  }

  return store.listForks(sessionId);
}

async function projectSession(store: SessionStore, sessionId: string): Promise<SessionPayload> {
  const session = await store.getSession(sessionId);

  return {
    session,
    status: deriveSessionStatus(session.events),
    view: deriveSessionView(session.events),
    forks: await listForks(store, sessionId)
  };
}

function streamEvents(store: SessionStore, sessionId: string, fromOffset: number): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));

      void (async () => {
        try {
          for await (const event of store.subscribe(sessionId, {
            fromOffset,
            signal: abort.signal
          })) {
            controller.enqueue(
              encoder.encode(`event: session-event\ndata: ${JSON.stringify(event)}\n\n`)
            );
          }
        } catch (error) {
          controller.error(error);
        }
      })();
    },
    cancel() {
      abort.abort();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object body");
  }

  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isInteger(field) ? field : undefined;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function htmlResponse(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function notFound(): Response {
  return jsonResponse({ error: "not found" }, 404);
}
