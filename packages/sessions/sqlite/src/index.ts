import { Database } from "bun:sqlite";
import type {
  AppendEventInput,
  Event,
  RestorableSession,
  SessionStore,
  SessionSummary,
  StoredEvent,
} from "@oma/runtime";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

type EventRow = {
  id: string;
  session_id: string;
  run_id: string;
  sequence: number;
  schema_version: number;
  type: string;
  at: string;
  data: string;
};

function eventFromRow(row: EventRow): StoredEvent {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
    at: row.at,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

function createTables(db: Database): void {
  db.exec(`
    create table if not exists sessions (
      id text primary key,
      created_at text not null
    );

    create table if not exists events (
      session_id text not null,
      sequence integer not null,
      id text not null,
      schema_version integer not null,
      run_id text not null,
      type text not null,
      at text not null,
      data text not null,
      primary key (session_id, sequence)
    );
  `);
}

function createSession(db: Database, id: string): RestorableSession {
  return {
    id,

    async append<TEvent extends Event>(event: AppendEventInput<TEvent>): Promise<TEvent> {
      const count = db
        .query("select count(*) as count from events where session_id = ?")
        .get(id) as { count: number };
      const stored = {
        ...event,
        schemaVersion: 1,
        id: createId("event"),
        sessionId: id,
        sequence: count.count + 1,
      } as TEvent;

      db.query(`
        insert into events (session_id, sequence, id, schema_version, run_id, type, at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        stored.sequence,
        stored.id,
        stored.schemaVersion,
        stored.runId,
        stored.type,
        stored.at,
        JSON.stringify(stored.data),
      );

      return stored;
    },

    async events(): Promise<StoredEvent[]> {
      const rows = db
        .query("select * from events where session_id = ? order by sequence asc")
        .all(id) as EventRow[];
      return rows.map(eventFromRow);
    },

    async restore(events: StoredEvent[]): Promise<void> {
      db.query("delete from events where session_id = ?").run(id);

      const insert = db.query(`
        insert into events (session_id, sequence, id, schema_version, run_id, type, at, data)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const event of events) {
        insert.run(
          id,
          event.sequence,
          event.id,
          event.schemaVersion,
          event.runId,
          event.type,
          event.at,
          JSON.stringify(event.data),
        );
      }
    },
  };
}

export function sqliteSessions(input: { path: string }): SessionStore {
  const db = new Database(input.path);
  createTables(db);

  return {
    async create(createInput = {}) {
      const id = createInput.id ?? createId("session");
      db.query("insert or ignore into sessions (id, created_at) values (?, ?)").run(
        id,
        new Date().toISOString(),
      );
      return createSession(db, id);
    },

    async open(id: string) {
      const row = db.query("select id from sessions where id = ?").get(id);
      if (!row) {
        throw new Error(`Session not found: ${id}`);
      }

      return createSession(db, id);
    },

    async list(): Promise<SessionSummary[]> {
      const rows = db
        .query("select id, created_at as createdAt from sessions order by created_at asc")
        .all() as SessionSummary[];
      return rows;
    },
  };
}
