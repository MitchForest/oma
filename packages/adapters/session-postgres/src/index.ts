import postgres from "postgres";
import {
  createEventId,
  createTimestamp,
  eventPayloadSchema,
  sessionEventSchema,
  sessionLifecycleEventTypes,
  type AppendEventOptions,
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ForkSummary,
  type GetSessionOptions,
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

// v2 renamed the event offset column from the reserved word `offset` to
// `event_offset`. There is no v1 migration: v1 DDL never initialized against
// a real Postgres (42601), so no v1 database can exist.
// v3 adds the oma_run_claims lease table.
const currentSchemaVersion = 3;

type QuerySql = postgres.Sql | postgres.TransactionSql;

export interface PostgresSessionStoreOptions {
  connectionString: string;
  pollMs?: number;
}

interface StoredEventRow {
  id: string;
  session_id: string;
  event_offset: number;
  created_at: string;
  type: string;
  payload_json: unknown;
}

interface SessionRow {
  id: string;
  metadata_json: unknown | null;
  created_at: string;
}

interface SummaryRow {
  id: string;
  metadata_json: unknown | null;
  created_at: string;
  latest_event_at: string | null;
  event_count: number;
}

type Subscriber = {
  onEvent: (event: SessionEvent) => void;
};

const lifecycleEventTypes = [...sessionLifecycleEventTypes];
const messageEventTypes = ["message.user", "message.assistant"];

export class PostgresSessionStore implements SessionStore, SessionProjectionStore, RunClaimStore {
  private readonly sql: postgres.Sql;
  private readonly ready: Promise<void>;
  private readonly pollMs: number;
  private readonly subscribers = new Map<SessionId, Set<Subscriber>>();

  constructor(options: PostgresSessionStoreOptions | string) {
    const config =
      typeof options === "string" ? { connectionString: options } : options;

    // `create table if not exists` during initialize emits NOTICEs on every
    // store instantiation; they are expected and not worth printing.
    this.sql = postgres(config.connectionString, { max: 10, onnotice: () => undefined });
    this.pollMs = config.pollMs ?? 200;
    this.ready = this.initialize();
  }

  capabilities(): SessionStoreCapabilities {
    return {
      durable: true,
      crossProcessSubscribe: true,
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
    await this.ready;
    const rows = await this.sql<{ worker_id: string; expires_at: Date }[]>`
      insert into oma_run_claims (session_id, worker_id, expires_at)
      values (${sessionId}, ${workerId}, now() + make_interval(secs => ${ttlMs / 1000}))
      on conflict (session_id) do update
        set worker_id = excluded.worker_id, expires_at = excluded.expires_at
        where oma_run_claims.expires_at <= now() or oma_run_claims.worker_id = excluded.worker_id
      returning worker_id, expires_at
    `;
    const row = rows[0];

    if (!row) {
      return undefined;
    }

    return { sessionId, workerId: row.worker_id, expiresAt: row.expires_at.toISOString() };
  }

  async renewClaim(sessionId: SessionId, workerId: string, ttlMs: number): Promise<boolean> {
    await this.ready;
    const rows = await this.sql`
      update oma_run_claims
      set expires_at = now() + make_interval(secs => ${ttlMs / 1000})
      where session_id = ${sessionId} and worker_id = ${workerId} and expires_at > now()
      returning session_id
    `;

    return rows.length > 0;
  }

  async releaseClaim(sessionId: SessionId, workerId: string): Promise<void> {
    await this.ready;
    await this.sql`
      delete from oma_run_claims where session_id = ${sessionId} and worker_id = ${workerId}
    `;
  }

  async getClaim(sessionId: SessionId): Promise<RunClaim | undefined> {
    await this.ready;
    const rows = await this.sql<{ worker_id: string; expires_at: Date }[]>`
      select worker_id, expires_at from oma_run_claims
      where session_id = ${sessionId} and expires_at > now()
    `;
    const row = rows[0];

    if (!row) {
      return undefined;
    }

    return { sessionId, workerId: row.worker_id, expiresAt: row.expires_at.toISOString() };
  }

  async schemaVersion(): Promise<number> {
    await this.ready;

    const [row] = await this.sql<{ version: number | null }[]>`
      select max(version) as version from oma_schema_version
    `;

    return row?.version ?? 0;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionId> {
    await this.ready;

    const id = options.id ?? crypto.randomUUID();

    try {
      await this.sql`
        insert into oma_sessions (id, metadata_json, created_at)
        values (${id}, ${jsonOrNull(options.metadata)}::jsonb, ${createTimestamp()})
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`Session already exists: ${id}`, { cause: error });
      }

      throw error;
    }

    return id;
  }

  async exists(sessionId: SessionId): Promise<boolean> {
    await this.ready;

    const rows = await this.sql`
      select 1 from oma_sessions where id = ${sessionId} limit 1
    `;

    return rows.length > 0;
  }

  async appendEvent(
    sessionId: SessionId,
    event: NewSessionEvent,
    options: AppendEventOptions = {}
  ): Promise<SessionEvent> {
    await this.ready;

    const appended = await this.sql.begin(async (tx) => {
      await this.requireSession(tx, sessionId, { lock: true });

      if (options.idempotencyKey) {
        const existing = await this.findIdempotentEvent(tx, sessionId, options.idempotencyKey);

        if (existing) {
          return existing;
        }
      }

      const nextOffset = await this.nextOffset(tx, sessionId);

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

      await insertEvent(tx, parsed, payload);

      if (options.idempotencyKey) {
        await tx`
          insert into oma_event_idempotency
            (session_id, idempotency_key, event_offset)
          values (${sessionId}, ${options.idempotencyKey}, ${parsed.offset})
        `;
      }

      return parsed;
    });

    this.publish(sessionId, appended);
    return appended;
  }

  async getSession(
    sessionId: SessionId,
    options: GetSessionOptions = {}
  ): Promise<SessionRecord> {
    await this.ready;

    const session = await this.requireSession(this.sql, sessionId);
    const rows = await this.eventsFromOffset(this.sql, sessionId, options.fromOffset ?? 0);

    return {
      id: sessionId,
      metadata: parseMetadata(session.metadata_json),
      createdAt: normalizeTimestamp(session.created_at),
      events: rows.map(parseEventRow)
    };
  }

  subscribe(
    sessionId: SessionId,
    options: SubscribeOptions = {}
  ): AsyncIterable<SessionEvent> {
    const fromOffset = options.fromOffset ?? 0;
    const queue: SessionEvent[] = [];
    const waiters: Array<{
      resolve: (value: IteratorResult<SessionEvent>) => void;
      reject: (error: unknown) => void;
    }> = [];
    const subscribers = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    let closed = false;
    let failure: unknown;
    let nextOffset = fromOffset;
    let wakeRequested = false;
    let wake: (() => void) | undefined;

    const wakePoll = () => {
      wakeRequested = true;
      wake?.();
    };
    const sleep = () =>
      new Promise<void>((resolve) => {
        if (wakeRequested) {
          wakeRequested = false;
          resolve();
          return;
        }

        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, this.pollMs);

        wake = () => {
          wake = undefined;
          wakeRequested = false;
          clearTimeout(timer);
          resolve();
        };
      });
    const deliver = (event: SessionEvent) => {
      nextOffset = event.offset + 1;

      const waiter = waiters.shift();

      if (waiter) {
        waiter.resolve({ done: false, value: event });
        return;
      }

      queue.push(event);
    };
    // In-process publishes only deliver the contiguous next event. Anything
    // else (a gap means undelivered history) just wakes the poll loop early:
    // the ordered poll query is the source of truth.
    const receive = (event: SessionEvent) => {
      if (closed) {
        return;
      }

      if (event.offset === nextOffset) {
        deliver(event);
        return;
      }

      if (event.offset > nextOffset) {
        wakePoll();
      }
    };
    const subscriber: Subscriber = { onEvent: receive };
    const close = () => {
      if (closed) {
        return;
      }

      closed = true;
      subscribers.delete(subscriber);
      wakePoll();

      while (waiters.length > 0) {
        waiters.shift()?.resolve({ done: true, value: undefined });
      }
    };
    const fail = (error: unknown) => {
      if (closed) {
        return;
      }

      failure = error;
      closed = true;
      subscribers.delete(subscriber);

      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    };
    const poll = async () => {
      try {
        await this.ready;
        await this.requireSession(this.sql, sessionId);

        while (!closed) {
          const rows = await this.eventsFromOffset(this.sql, sessionId, nextOffset);

          for (const row of rows) {
            const event = parseEventRow(row);

            // A concurrent in-process publish may already have delivered
            // some of these rows; only the contiguous next one counts.
            if (event.offset === nextOffset) {
              deliver(event);
            }
          }

          if (closed) {
            break;
          }

          await sleep();
        }
      } catch (error) {
        fail(error);
      }
    };

    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);

    if (options.signal?.aborted) {
      close();
    } else {
      options.signal?.addEventListener("abort", close, { once: true });
      void poll();
    }

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SessionEvent>> {
            if (queue.length > 0) {
              return Promise.resolve({ done: false, value: queue.shift()! });
            }

            if (failure !== undefined) {
              return Promise.reject(failure);
            }

            if (closed) {
              return Promise.resolve({ done: true, value: undefined });
            }

            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
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
    await this.ready;

    const { newSessionId, marker } = await this.sql.begin(async (tx) => {
      const source = await this.requireSession(tx, sessionId, { lock: true });
      const existsAtOffset = await tx`
        select 1 from oma_events
        where session_id = ${sessionId} and event_offset = ${atOffset}
        limit 1
      `;

      if (existsAtOffset.length === 0) {
        throw new Error(`Offset not found: ${atOffset}`);
      }

      const id = options.id ?? crypto.randomUUID();
      const metadata = options.metadata ?? parseMetadata(source.metadata_json);

      await tx`
        insert into oma_sessions (id, metadata_json, created_at)
        values (${id}, ${jsonOrNull(metadata)}::jsonb, ${createTimestamp()})
      `;

      const rows = await tx<StoredEventRow[]>`
        select id, session_id, event_offset, created_at::text, type, payload_json
        from oma_events
        where session_id = ${sessionId} and event_offset <= ${atOffset}
        order by event_offset asc
      `;

      for (const [offset, row] of rows.entries()) {
        const payload = parsePayload(row.payload_json);
        // Copies keep the source payload and createdAt; only ids change.
        const event = sessionEventSchema.parse({
          ...payload,
          id: createEventId(),
          sessionId: id,
          offset,
          createdAt: normalizeTimestamp(row.created_at)
        });

        await insertEvent(tx, event, payload);
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

      await insertEvent(tx, markerEvent, markerPayload);

      return { newSessionId: id, marker: markerEvent };
    });

    this.publish(newSessionId, marker);
    return newSessionId;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    await this.ready;

    const rows =
      typeof options.limit === "number"
        ? await this.sql<SummaryRow[]>`
            select
              sessions.id,
              sessions.metadata_json,
              sessions.created_at::text,
              max(events.created_at)::text as latest_event_at,
              count(events.id)::int as event_count
            from oma_sessions sessions
            left join oma_events events on events.session_id = sessions.id
            group by sessions.id
            order by coalesce(max(events.created_at), sessions.created_at) desc
            limit ${options.limit}
          `
        : await this.sql<SummaryRow[]>`
            select
              sessions.id,
              sessions.metadata_json,
              sessions.created_at::text,
              max(events.created_at)::text as latest_event_at,
              count(events.id)::int as event_count
            from oma_sessions sessions
            left join oma_events events on events.session_id = sessions.id
            group by sessions.id
            order by coalesce(max(events.created_at), sessions.created_at) desc
          `;
    const summaries: SessionSummary[] = [];

    for (const row of rows) {
      summaries.push(await this.summarizeRow(row));
    }

    return summaries;
  }

  async getSessionSummary(sessionId: SessionId): Promise<SessionSummary> {
    await this.ready;

    const session = await this.requireSession(this.sql, sessionId);
    const [aggregate] = await this.sql<
      { latest_event_at: string | null; event_count: number }[]
    >`
      select max(created_at)::text as latest_event_at, count(*)::int as event_count
      from oma_events
      where session_id = ${sessionId}
    `;

    return this.summarizeRow({
      id: sessionId,
      metadata_json: session.metadata_json,
      created_at: session.created_at,
      latest_event_at: aggregate?.latest_event_at ?? null,
      event_count: aggregate?.event_count ?? 0
    });
  }

  async listForks(sessionId: SessionId): Promise<ForkSummary[]> {
    await this.ready;

    const rows = await this.sql<
      Array<Pick<StoredEventRow, "session_id" | "created_at" | "payload_json">>
    >`
      select session_id, created_at::text, payload_json
      from oma_events
      where type = 'session.forked'
      order by created_at asc
    `;

    return rows
      .map((row) => {
        const payload = parsePayload(row.payload_json) as {
          fromSessionId: string;
          atOffset: number;
        };

        return {
          sessionId: row.session_id,
          forkedFromSessionId: payload.fromSessionId,
          atOffset: payload.atOffset,
          createdAt: normalizeTimestamp(row.created_at)
        };
      })
      .filter((fork) => fork.sessionId === sessionId || fork.forkedFromSessionId === sessionId);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  private async initialize(): Promise<void> {
    await this.sql`
      create table if not exists oma_sessions (
        id text primary key,
        metadata_json jsonb,
        created_at timestamptz not null
      )
    `;
    await this.sql`
      create table if not exists oma_events (
        session_id text not null references oma_sessions(id) on delete cascade,
        event_offset integer not null,
        id text not null,
        created_at timestamptz not null,
        type text not null,
        payload_json jsonb not null,
        primary key (session_id, event_offset),
        unique (id)
      )
    `;
    await this.sql`
      create table if not exists oma_event_idempotency (
        session_id text not null references oma_sessions(id) on delete cascade,
        idempotency_key text not null,
        event_offset integer not null,
        primary key (session_id, idempotency_key)
      )
    `;
    await this.sql`
      create table if not exists oma_run_claims (
        session_id text primary key,
        worker_id text not null,
        expires_at timestamptz not null
      )
    `;
    await this.sql`
      create table if not exists oma_schema_version (
        version integer primary key,
        applied_at timestamptz not null
      )
    `;

    const version = await this.schemaVersionWithoutReady();

    if (version > currentSchemaVersion) {
      throw new Error(`Unsupported Postgres store schema version: ${version}`);
    }

    if (version < currentSchemaVersion) {
      await this.sql`
        insert into oma_schema_version (version, applied_at)
        values (${currentSchemaVersion}, ${createTimestamp()})
        on conflict (version) do nothing
      `;
    }
  }

  private async schemaVersionWithoutReady(): Promise<number> {
    const [row] = await this.sql<{ version: number | null }[]>`
      select max(version) as version from oma_schema_version
    `;

    return row?.version ?? 0;
  }

  private async requireSession(
    sql: QuerySql,
    sessionId: SessionId,
    options: { lock?: boolean } = {}
  ): Promise<SessionRow> {
    const rows = options.lock
      ? await sql<SessionRow[]>`
          select id, metadata_json, created_at::text
          from oma_sessions
          where id = ${sessionId}
          for update
        `
      : await sql<SessionRow[]>`
          select id, metadata_json, created_at::text
          from oma_sessions
          where id = ${sessionId}
        `;
    const row = rows[0];

    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return row;
  }

  private async nextOffset(sql: QuerySql, sessionId: SessionId): Promise<number> {
    const [row] = await sql<{ count: string | number }[]>`
      select count(*) as count from oma_events where session_id = ${sessionId}
    `;

    return Number(row?.count ?? 0);
  }

  private async findIdempotentEvent(
    sql: QuerySql,
    sessionId: SessionId,
    idempotencyKey: string
  ): Promise<SessionEvent | undefined> {
    const [row] = await sql<StoredEventRow[]>`
      select
        events.id,
        events.session_id,
        events.event_offset,
        events.created_at::text,
        events.type,
        events.payload_json
      from oma_event_idempotency
      join oma_events events
        on events.session_id = oma_event_idempotency.session_id
       and events.event_offset = oma_event_idempotency.event_offset
      where oma_event_idempotency.session_id = ${sessionId}
        and oma_event_idempotency.idempotency_key = ${idempotencyKey}
    `;

    return row ? parseEventRow(row) : undefined;
  }

  private async eventsFromOffset(
    sql: QuerySql,
    sessionId: SessionId,
    fromOffset: number
  ): Promise<StoredEventRow[]> {
    return sql<StoredEventRow[]>`
      select id, session_id, event_offset, created_at::text, type, payload_json
      from oma_events
      where session_id = ${sessionId} and event_offset >= ${fromOffset}
      order by event_offset asc
    `;
  }

  private async summarizeRow(row: SummaryRow): Promise<SessionSummary> {
    const metadata = parseMetadata(row.metadata_json);
    const [lifecycle] = await this.sql<{ type: string; payload_json: unknown }[]>`
      select type, payload_json from oma_events
      where session_id = ${row.id} and type = any(${lifecycleEventTypes})
      order by event_offset desc
      limit 1
    `;
    const [message] = await this.sql<{ payload_json: unknown }[]>`
      select payload_json from oma_events
      where session_id = ${row.id} and type = any(${messageEventTypes})
      order by event_offset desc
      limit 1
    `;

    let profileName =
      typeof metadata?.profileName === "string" ? metadata.profileName : undefined;

    if (profileName === undefined) {
      const [started] = await this.sql<{ payload_json: unknown }[]>`
        select payload_json from oma_events
        where session_id = ${row.id} and type = 'session.started'
        order by event_offset asc
        limit 1
      `;

      profileName = started ? profileNameFromPayload(parsePayload(started.payload_json)) : undefined;
    }

    return {
      id: row.id,
      metadata,
      createdAt: normalizeTimestamp(row.created_at),
      latestEventAt: row.latest_event_at ? normalizeTimestamp(row.latest_event_at) : undefined,
      eventCount: row.event_count,
      status: statusFromLifecycle(lifecycle?.type, lifecycle ? parsePayload(lifecycle.payload_json) : undefined),
      profileName,
      profilePath:
        typeof metadata?.profilePath === "string" ? metadata.profilePath : undefined,
      preview: message ? previewFromPayload(parsePayload(message.payload_json)) : undefined
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

async function insertEvent(
  sql: QuerySql,
  event: SessionEvent,
  payload: NewSessionEvent
): Promise<void> {
  await sql`
    insert into oma_events
      (session_id, event_offset, id, created_at, type, payload_json)
    values (
      ${event.sessionId},
      ${event.offset},
      ${event.id},
      ${event.createdAt},
      ${event.type},
      ${JSON.stringify(payload)}::jsonb
    )
  `;
}

function parseEventRow(row: StoredEventRow): SessionEvent {
  return sessionEventSchema.parse({
    ...parsePayload(row.payload_json),
    id: row.id,
    sessionId: row.session_id,
    offset: row.event_offset,
    createdAt: normalizeTimestamp(row.created_at)
  });
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value as Record<string, unknown>;
}

function parsePayload(value: unknown): NewSessionEvent {
  if (typeof value === "string") {
    return JSON.parse(value) as NewSessionEvent;
  }

  return value as NewSessionEvent;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
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

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}

// Stores SQL NULL (not jsonb null) when the value is absent.
function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
