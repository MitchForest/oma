import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createId } from "./ids";
import type {
  AppendEventInput,
  Event,
  RestorableSession,
  Session,
  SessionStore,
  SessionSummary,
  StoredEvent,
} from "./types";

const eventSchemaVersion = 1;

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function createSession(
  id: string,
  events: StoredEvent[],
  persistAppend?: (event: StoredEvent) => Promise<void>,
  persistRestore?: (events: StoredEvent[]) => Promise<void>,
): RestorableSession {
  return {
    id,

    async append<TEvent extends Event>(event: AppendEventInput<TEvent>): Promise<TEvent> {
      const stored = {
        ...event,
        schemaVersion: eventSchemaVersion,
        id: createId("event"),
        sessionId: id,
        sequence: events.length + 1,
      } as TEvent;

      events.push(stored);
      await persistAppend?.(stored);
      return stored;
    },

    async events(): Promise<StoredEvent[]> {
      return [...events];
    },

    async restore(nextEvents: StoredEvent[]): Promise<void> {
      events.splice(0, events.length, ...nextEvents);
      await persistRestore?.(events);
    },
  };
}

function restorable(session: Session): RestorableSession {
  if (!("restore" in session) || typeof session.restore !== "function") {
    throw new Error("Session store does not support event import.");
  }

  return session as RestorableSession;
}

export function memoryStore(): SessionStore {
  const sessions = new Map<string, { createdAt: string; events: StoredEvent[] }>();

  return {
    async create(input = {}) {
      const id = input.id ?? createId("session");
      if (!sessions.has(id)) {
        sessions.set(id, { createdAt: new Date().toISOString(), events: [] });
      }

      return this.open(id);
    },

    async open(id: string) {
      const record = sessions.get(id);
      if (!record) {
        throw new Error(`Session not found: ${id}`);
      }

      return createSession(id, record.events);
    },

    async list(): Promise<SessionSummary[]> {
      return [...sessions.entries()].map(([id, record]) => ({
        id,
        createdAt: record.createdAt,
      }));
    },
  };
}

export function memorySession(): Session {
  const id = createId("session");
  return createSession(id, []);
}

function sessionPath(dir: string, id: string): string {
  return join(dir, `${id}.jsonl`);
}

async function readJsonl(path: string): Promise<StoredEvent[] | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoredEvent);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function writeJsonl(path: string, events: StoredEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
}

async function appendJsonl(path: string, event: StoredEvent): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function jsonlStore(input: { dir: string }): SessionStore {
  const { dir } = input;
  const appendQueues = new Map<string, Promise<void>>();

  function enqueueAppend(id: string, path: string, event: StoredEvent): Promise<void> {
    const previous = appendQueues.get(id) ?? Promise.resolve();
    const next = previous.then(() => appendJsonl(path, event));
    appendQueues.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  return {
    async create(createInput = {}) {
      const id = createInput.id ?? createId("session");
      const path = sessionPath(dir, id);
      await writeJsonl(path, (await readJsonl(path)) ?? []);
      return this.open(id);
    },

    async open(id: string) {
      const path = sessionPath(dir, id);
      const events = await readJsonl(path);
      if (!events) {
        throw new Error(`Session not found: ${id}`);
      }

      return createSession(
        id,
        events,
        (event) => enqueueAppend(id, path, event),
        (nextEvents) => writeJsonl(path, nextEvents),
      );
    },

    async list(): Promise<SessionSummary[]> {
      try {
        const files = await readdir(dir);
        const summaries = await Promise.all(
          files
            .filter((file) => file.endsWith(".jsonl"))
            .map(async (file) => {
              const metadata = await stat(join(dir, file));
              return {
                id: file.slice(0, -".jsonl".length),
                createdAt: metadata.birthtime.toISOString(),
              };
            }),
        );
        return summaries;
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return [];
        }

        throw error;
      }
    },
  };
}

export async function exportJsonl(session: Session): Promise<string> {
  const events = await session.events();
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  return body.length > 0 ? `${body}\n` : "";
}

export async function importJsonl(
  store: SessionStore,
  jsonl: string,
  input: { id?: string } = {},
): Promise<Session> {
  const events = jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StoredEvent);
  const id = input.id ?? events[0]?.sessionId ?? createId("session");
  const session = await store.create({ id });
  await restorable(session).restore(events);
  return session;
}

export const sessions = {
  ephemeral: memorySession,
  exportJsonl,
  importJsonl,
  jsonl: jsonlStore,
  memory: memoryStore,
};
