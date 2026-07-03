import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createEventId,
  createTimestamp,
  eventPayloadSchema,
  sessionEventSchema,
  sessionLifecycleEventTypes,
  type AppendEventOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type GetSessionOptions,
  type ForkSummary,
  type ListSessionsOptions,
  type NewSessionEvent,
  type RunClaim,
  type RunClaimStore,
  type SessionEvent,
  type SessionId,
  type SessionProjectionStore,
  type SessionRecord,
  type SessionStatus,
  type SessionStore,
  type SessionStoreCapabilities,
  type SessionSummary,
  type SubscribeOptions
} from "@oma/core";

type Subscriber = {
  onEvent: (event: SessionEvent) => void;
};

interface StoredEventRow {
  id: string;
  session_id: string;
  event_offset: number;
  created_at: string;
  type: string;
  payload_json: string;
}

interface SummaryRow {
  id: string;
  metadata_json: string | null;
  created_at: string;
  latest_event_at: string | null;
  event_count: number;
}

// v3 adds the run_claims lease table.
const currentSchemaVersion = 3;

export class SqliteSessionStore implements SessionStore, SessionProjectionStore, RunClaimStore {
  private readonly db: Database;
  private readonly subscribers = new Map<SessionId, Set<Subscriber>>();

  constructor(path = ".oma/sessions.sqlite") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  capabilities(): SessionStoreCapabilities {
    return {
      durable: true,
      crossProcessSubscribe: false,
      efficientFork: false,
      listSessions: true,
      projections: true,
      runClaims: true
    };
  }

  async claimRun(
    sessionId: SessionId,
    workerId: string,
    ttlMs: number
  ): Promise<RunClaim | undefined> {
    const expiresAt = Date.now() + ttlMs;
    const claim = this.db
      .transaction(() => {
        const existing = this.db
          .query("select worker_id, expires_at from run_claims where session_id = ?")
          .get(sessionId) as { worker_id: string; expires_at: number } | null;

        if (existing && existing.expires_at > Date.now() && existing.worker_id !== workerId) {
          return undefined;
        }

        this.db
          .query(
            `insert into run_claims (session_id, worker_id, expires_at) values (?, ?, ?)
             on conflict (session_id) do update set worker_id = excluded.worker_id, expires_at = excluded.expires_at`
          )
          .run(sessionId, workerId, expiresAt);

        return { sessionId, workerId, expiresAt: new Date(expiresAt).toISOString() };
      })
      .immediate();

    return claim;
  }

  async renewClaim(sessionId: SessionId, workerId: string, ttlMs: number): Promise<boolean> {
    const changes = this.db
      .query(
        "update run_claims set expires_at = ? where session_id = ? and worker_id = ? and expires_at > ?"
      )
      .run(Date.now() + ttlMs, sessionId, workerId, Date.now());

    return changes.changes > 0;
  }

  async releaseClaim(sessionId: SessionId, workerId: string): Promise<void> {
    this.db
      .query("delete from run_claims where session_id = ? and worker_id = ?")
      .run(sessionId, workerId);
  }

  async getClaim(sessionId: SessionId): Promise<RunClaim | undefined> {
    const row = this.db
      .query("select worker_id, expires_at from run_claims where session_id = ? and expires_at > ?")
      .get(sessionId, Date.now()) as { worker_id: string; expires_at: number } | null;

    if (!row) {
      return undefined;
    }

    return {
      sessionId,
      workerId: row.worker_id,
      expiresAt: new Date(row.expires_at).toISOString()
    };
  }

  schemaVersion(): number {
    const row = this.db
      .query("select max(version) as version from oma_schema_version")
      .get() as { version: number | null };

    return row.version ?? 0;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionId> {
    const id = options.id ?? crypto.randomUUID();
    const metadataJson = options.metadata ? JSON.stringify(options.metadata) : null;

    try {
      this.db
        .query("insert into sessions (id, metadata_json, created_at) values (?, ?, ?)")
        .run(id, metadataJson, createTimestamp());
    } catch (error) {
      if (isConstraintError(error)) {
        throw new Error(`Session already exists: ${id}`, { cause: error });
      }

      throw error;
    }

    return id;
  }

  async exists(sessionId: SessionId): Promise<boolean> {
    const row = this.db.query("select 1 from sessions where id = ?").get(sessionId);
    return Boolean(row);
  }

  async appendEvent(
    sessionId: SessionId,
    event: NewSessionEvent,
    options: AppendEventOptions = {}
  ): Promise<SessionEvent> {
    const appended = this.db
      .transaction(() => {
        this.requireSession(sessionId);

        if (options.idempotencyKey) {
          const existing = this.findIdempotentEvent(sessionId, options.idempotencyKey);

          if (existing) {
            return existing;
          }
        }

        const nextOffset = this.nextOffset(sessionId);

        if (
          options.expectedOffset !== undefined &&
          options.expectedOffset !== nextOffset
        ) {
          throw new Error(`Expected offset ${options.expectedOffset}, got ${nextOffset}`);
        }

        const payload = eventPayloadSchema.parse(event);
        const parsed = sessionEventSchema.parse({
          ...payload,
          id: createEventId(),
          sessionId,
          offset: nextOffset,
          createdAt: createTimestamp()
        });

        this.insertEvent(parsed, payload);

        if (options.idempotencyKey) {
          this.db
            .query(
              `insert into event_idempotency
                (session_id, idempotency_key, event_offset)
               values (?, ?, ?)`
            )
            .run(sessionId, options.idempotencyKey, parsed.offset);
        }

        return parsed;
      })
      .immediate();

    this.publish(sessionId, appended);
    return appended;
  }

  async getSession(
    sessionId: SessionId,
    options: GetSessionOptions = {}
  ): Promise<SessionRecord> {
    const session = this.requireSession(sessionId);
    const rows = this.db
      .query(
        `select id, session_id, event_offset, created_at, type, payload_json
         from events
         where session_id = ? and event_offset >= ?
         order by event_offset asc`
      )
      .all(sessionId, options.fromOffset ?? 0) as StoredEventRow[];

    return {
      id: sessionId,
      metadata: parseMetadata(session.metadata_json),
      createdAt: session.created_at,
      events: rows.map(parseEventRow)
    };
  }

  subscribe(
    sessionId: SessionId,
    options: SubscribeOptions = {}
  ): AsyncIterable<SessionEvent> {
    this.requireSession(sessionId);

    const rows = this.db
      .query(
        `select id, session_id, event_offset, created_at, type, payload_json
         from events
         where session_id = ? and event_offset >= ?
         order by event_offset asc`
      )
      .all(sessionId, options.fromOffset ?? 0) as StoredEventRow[];
    const queue = rows.map(parseEventRow);
    const waiters: Array<(value: IteratorResult<SessionEvent>) => void> = [];
    let closed = false;

    const subscribers = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    const subscriber: Subscriber = {
      onEvent: (event) => {
        if (event.offset < (options.fromOffset ?? 0)) {
          return;
        }

        if (waiters.length > 0) {
          waiters.shift()?.({ done: false, value: event });
          return;
        }

        queue.push(event);
      }
    };
    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      subscribers.delete(subscriber);

      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    };

    if (options.signal?.aborted) {
      queue.length = 0;
      close();
    } else {
      options.signal?.addEventListener("abort", close, { once: true });
    }

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SessionEvent>> {
            if (queue.length > 0) {
              return Promise.resolve({ done: false, value: queue.shift()! });
            }

            if (closed) {
              return Promise.resolve({ done: true, value: undefined });
            }

            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<SessionEvent>> {
            close();
            return Promise.resolve({ done: true, value: undefined });
          }
        };
      }
    };
  }

  async fork(
    sessionId: SessionId,
    atOffset: number,
    options: ForkSessionOptions = {}
  ): Promise<SessionId> {
    const { newSessionId, marker } = this.db
      .transaction(() => {
        const source = this.requireSession(sessionId);
        const existsAtOffset = this.db
          .query("select 1 from events where session_id = ? and event_offset = ?")
          .get(sessionId, atOffset);

        if (!existsAtOffset) {
          throw new Error(`Offset not found: ${atOffset}`);
        }

        const id = options.id ?? crypto.randomUUID();
        const metadataJson = options.metadata
          ? JSON.stringify(options.metadata)
          : source.metadata_json;

        this.db
          .query("insert into sessions (id, metadata_json, created_at) values (?, ?, ?)")
          .run(id, metadataJson, createTimestamp());

        const rows = this.db
          .query(
            `select id, session_id, event_offset, created_at, type, payload_json
             from events
             where session_id = ? and event_offset <= ?
             order by event_offset asc`
          )
          .all(sessionId, atOffset) as StoredEventRow[];

        for (const [offset, row] of rows.entries()) {
          const payload = JSON.parse(row.payload_json) as NewSessionEvent;
          // Copies keep the source payload and createdAt; only ids change.
          const event = sessionEventSchema.parse({
            ...payload,
            id: createEventId(),
            sessionId: id,
            offset,
            createdAt: row.created_at
          });

          this.insertEvent(event, payload);
        }

        // The fork marker commits atomically with the copy, so a fork is
        // never visible without its provenance.
        const markerPayload: NewSessionEvent = {
          type: "session.forked",
          fromSessionId: sessionId,
          atOffset
        };
        const markerEvent = sessionEventSchema.parse({
          ...markerPayload,
          id: createEventId(),
          sessionId: id,
          offset: rows.length,
          createdAt: createTimestamp()
        });

        this.insertEvent(markerEvent, markerPayload);

        return { newSessionId: id, marker: markerEvent };
      })
      .immediate();

    this.publish(newSessionId, marker);
    return newSessionId;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const rows = this.db
      .query(
        `select
          sessions.id,
          sessions.metadata_json,
          sessions.created_at,
          max(events.created_at) as latest_event_at,
          count(events.id) as event_count
        from sessions
        left join events on events.session_id = sessions.id
        group by sessions.id
        order by coalesce(max(events.created_at), sessions.created_at) desc
        ${typeof options.limit === "number" ? "limit ?" : ""}`
      )
      .all(...(typeof options.limit === "number" ? [options.limit] : [])) as SummaryRow[];

    return rows.map((row) => this.summarizeRow(row));
  }

  async getSessionSummary(sessionId: SessionId): Promise<SessionSummary> {
    const session = this.requireSession(sessionId);
    const aggregate = this.db
      .query(
        `select max(created_at) as latest_event_at, count(*) as event_count
         from events
         where session_id = ?`
      )
      .get(sessionId) as { latest_event_at: string | null; event_count: number };

    return this.summarizeRow({
      id: sessionId,
      metadata_json: session.metadata_json,
      created_at: session.created_at,
      latest_event_at: aggregate.latest_event_at,
      event_count: aggregate.event_count
    });
  }

  async listForks(sessionId: SessionId): Promise<ForkSummary[]> {
    const rows = this.db
      .query(
        `select session_id, created_at, payload_json
         from events
         where type = 'session.forked'
         order by created_at asc`
      )
      .all() as Array<Pick<StoredEventRow, "session_id" | "created_at" | "payload_json">>;

    return rows
      .map((row) => {
        const payload = JSON.parse(row.payload_json) as {
          fromSessionId: string;
          atOffset: number;
        };

        return {
          sessionId: row.session_id,
          forkedFromSessionId: payload.fromSessionId,
          atOffset: payload.atOffset,
          createdAt: row.created_at
        };
      })
      .filter((fork) => fork.sessionId === sessionId || fork.forkedFromSessionId === sessionId);
  }

  close(): void {
    this.db.close();
  }

  private requireSession(sessionId: SessionId): { metadata_json: string | null; created_at: string } {
    const row = this.db
      .query("select metadata_json, created_at from sessions where id = ?")
      .get(sessionId) as { metadata_json: string | null; created_at: string } | null;

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return row;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists oma_schema_version (
        version integer primary key,
        applied_at text not null
      );
    `);

    this.db
      .transaction(() => {
        const existing = this.schemaVersion();

        if (existing > currentSchemaVersion) {
          throw new Error(`Unsupported SQLite store schema version: ${existing}`);
        }

        // v1 -> v2: the event offset column was renamed from the reserved
        // word `offset` to `event_offset` (symmetry with the Postgres store).
        if (this.hasLegacyOffsetColumn("events")) {
          this.db.exec(`alter table events rename column "offset" to event_offset`);
        }

        if (this.hasLegacyOffsetColumn("event_idempotency")) {
          this.db.exec(`alter table event_idempotency rename column "offset" to event_offset`);
        }

        this.db.exec(`
          create table if not exists sessions (
            id text primary key,
            metadata_json text,
            created_at text not null
          );

          create table if not exists events (
            session_id text not null references sessions(id) on delete cascade,
            event_offset integer not null,
            id text not null,
            created_at text not null,
            type text not null,
            payload_json text not null,
            primary key (session_id, event_offset),
            unique (id)
          );

          create table if not exists event_idempotency (
            session_id text not null references sessions(id) on delete cascade,
            idempotency_key text not null,
            event_offset integer not null,
            primary key (session_id, idempotency_key)
          );

          create table if not exists run_claims (
            session_id text primary key,
            worker_id text not null,
            expires_at integer not null
          );
        `);

        this.db
          .query("insert or ignore into oma_schema_version (version, applied_at) values (?, ?)")
          .run(currentSchemaVersion, createTimestamp());
      })
      .immediate();
  }

  private hasLegacyOffsetColumn(table: string): boolean {
    const row = this.db
      .query("select 1 from pragma_table_info(?) where name = 'offset'")
      .get(table);

    return Boolean(row);
  }

  private insertEvent(event: SessionEvent, payload: NewSessionEvent): void {
    this.db
      .query(
        `insert into events
          (session_id, event_offset, id, created_at, type, payload_json)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.sessionId,
        event.offset,
        event.id,
        event.createdAt,
        event.type,
        JSON.stringify(payload)
      );
  }

  private nextOffset(sessionId: SessionId): number {
    const row = this.db
      .query("select count(*) as count from events where session_id = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  private findIdempotentEvent(
    sessionId: SessionId,
    idempotencyKey: string
  ): SessionEvent | undefined {
    const row = this.db
      .query(
        `select events.id, events.session_id, events.event_offset, events.created_at, events.type, events.payload_json
         from event_idempotency
         join events
           on events.session_id = event_idempotency.session_id
          and events.event_offset = event_idempotency.event_offset
         where event_idempotency.session_id = ?
           and event_idempotency.idempotency_key = ?`
      )
      .get(sessionId, idempotencyKey) as StoredEventRow | null;

    return row ? parseEventRow(row) : undefined;
  }

  private summarizeRow(row: SummaryRow): SessionSummary {
    const metadata = parseMetadata(row.metadata_json);
    const lifecyclePlaceholders = sessionLifecycleEventTypes.map(() => "?").join(", ");
    const lifecycle = this.db
      .query(
        `select type, payload_json from events
         where session_id = ?
           and type in (${lifecyclePlaceholders})
         order by event_offset desc
         limit 1`
      )
      .get(row.id, ...sessionLifecycleEventTypes) as
      | { type: string; payload_json: string }
      | null;
    const message = this.db
      .query(
        `select payload_json from events
         where session_id = ?
           and type in ('message.user', 'message.assistant')
         order by event_offset desc
         limit 1`
      )
      .get(row.id) as { payload_json: string } | null;

    let profileName =
      typeof metadata?.profileName === "string" ? metadata.profileName : undefined;

    if (profileName === undefined) {
      const started = this.db
        .query(
          `select payload_json from events
           where session_id = ? and type = 'session.started'
           order by event_offset asc
           limit 1`
        )
        .get(row.id) as { payload_json: string } | null;

      profileName = started ? profileNameFromPayload(JSON.parse(started.payload_json)) : undefined;
    }

    return {
      id: row.id,
      metadata,
      createdAt: row.created_at,
      latestEventAt: row.latest_event_at ?? undefined,
      eventCount: row.event_count,
      status: statusFromLifecycle(lifecycle?.type, lifecycle ? JSON.parse(lifecycle.payload_json) : undefined),
      profileName,
      profilePath:
        typeof metadata?.profilePath === "string" ? metadata.profilePath : undefined,
      preview: message ? previewFromPayload(JSON.parse(message.payload_json)) : undefined
    };
  }

  private publish(sessionId: SessionId, event: SessionEvent): void {
    const subscribers = this.subscribers.get(sessionId);

    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber.onEvent(event);
    }
  }
}

function parseEventRow(row: StoredEventRow): SessionEvent {
  return sessionEventSchema.parse({
    ...JSON.parse(row.payload_json),
    id: row.id,
    sessionId: row.session_id,
    offset: row.event_offset,
    createdAt: row.created_at
  });
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as Record<string, unknown>;
}

function isConstraintError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

function statusFromLifecycle(type: string | undefined, payload?: unknown): SessionStatus {
  switch (type) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.paused":
      return "paused";
    case "run.started":
      return "running";
    case "workflow.run.completed":
      return (payload as { status?: string } | null)?.status === "completed"
        ? "completed"
        : "failed";
    case "workflow.stage.dispatched":
    case "human.approval.requested":
    case "human.approval.denied":
      return "paused";
    case "workflow.run.started":
    case "workflow.stage.started":
    case "human.approval.granted":
      return "running";
    default:
      return "new";
  }
}

function previewFromPayload(payload: unknown): string | undefined {
  const content = (payload as { content?: unknown } | null)?.content;

  if (typeof content !== "string") {
    return undefined;
  }

  return content.replace(/\s+/g, " ").slice(0, 120);
}

function profileNameFromPayload(payload: unknown): string | undefined {
  const profileName = (payload as { profileName?: unknown } | null)?.profileName;

  return typeof profileName === "string" ? profileName : undefined;
}
