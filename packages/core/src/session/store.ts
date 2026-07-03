import type { NewSessionEvent, SessionEvent } from "./events";

export type SessionId = string;

export interface SessionRecord {
  id: SessionId;
  events: SessionEvent[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface CreateSessionOptions {
  id?: SessionId;
  metadata?: Record<string, unknown>;
}

export interface AppendEventOptions {
  expectedOffset?: number;
  idempotencyKey?: string;
}

export interface GetSessionOptions {
  fromOffset?: number;
}

export interface SubscribeOptions {
  fromOffset?: number;
  signal?: AbortSignal;
}

export interface ForkSessionOptions {
  id?: SessionId;
  metadata?: Record<string, unknown>;
}

export interface SessionStore {
  createSession(options?: CreateSessionOptions): Promise<SessionId>;
  exists(sessionId: SessionId): Promise<boolean>;
  appendEvent(
    sessionId: SessionId,
    event: NewSessionEvent,
    options?: AppendEventOptions
  ): Promise<SessionEvent>;
  getSession(sessionId: SessionId, options?: GetSessionOptions): Promise<SessionRecord>;
  subscribe(sessionId: SessionId, options?: SubscribeOptions): AsyncIterable<SessionEvent>;
  fork(sessionId: SessionId, atOffset: number, options?: ForkSessionOptions): Promise<SessionId>;
}

export interface SessionStoreCapabilities {
  durable: boolean;
  crossProcessSubscribe: boolean;
  efficientFork: boolean;
  listSessions: boolean;
  projections: boolean;
  /** Durable run claims: lease-based exclusive progress across processes. */
  runClaims?: boolean;
}

export interface SessionStoreWithCapabilities extends SessionStore {
  capabilities(): SessionStoreCapabilities;
}

export type SessionStatus = "new" | "running" | "completed" | "paused" | "failed";

export interface SessionSummary {
  id: SessionId;
  metadata?: Record<string, unknown>;
  createdAt: string;
  latestEventAt?: string;
  eventCount: number;
  status: SessionStatus;
  profileName?: string;
  profilePath?: string;
  preview?: string;
}

export interface ForkSummary {
  sessionId: SessionId;
  forkedFromSessionId: SessionId;
  atOffset: number;
  createdAt: string;
}

export interface ListSessionsOptions {
  limit?: number;
}

export interface SessionProjectionStore extends SessionStore {
  listSessions(options?: ListSessionsOptions): Promise<SessionSummary[]>;
  getSessionSummary(sessionId: SessionId): Promise<SessionSummary>;
  listForks(sessionId: SessionId): Promise<ForkSummary[]>;
}

export function hasSessionStoreCapabilities(
  store: SessionStore
): store is SessionStoreWithCapabilities {
  return typeof (store as Partial<SessionStoreWithCapabilities>).capabilities === "function";
}

export function sessionStoreCapabilities(store: SessionStore): SessionStoreCapabilities {
  if (hasSessionStoreCapabilities(store)) {
    return store.capabilities();
  }

  return {
    durable: false,
    crossProcessSubscribe: false,
    efficientFork: false,
    listSessions: false,
    projections: false
  };
}

/** A held (or refused) lease on exclusive progress for one session. */
export interface RunClaim {
  sessionId: SessionId;
  workerId: string;
  /** ISO timestamp the lease expires unless renewed. */
  expiresAt: string;
}

/**
 * Lease-based exclusive progress. Claims are the primitive that lets local
 * CLIs, daemons, and workers share one store without double-waking a session:
 * a claim succeeds when the session is unclaimed, the existing lease has
 * expired (crash recovery), or the same worker re-claims (renewal by another
 * name). All operations are atomic per store.
 */
export interface RunClaimStore extends SessionStore {
  /** Returns the claim when acquired, undefined when another live lease holds it. */
  claimRun(sessionId: SessionId, workerId: string, ttlMs: number): Promise<RunClaim | undefined>;
  /** Extends a held lease; false when the lease is no longer this worker's. */
  renewClaim(sessionId: SessionId, workerId: string, ttlMs: number): Promise<boolean>;
  /** Releases a held lease; a no-op when not held by this worker. */
  releaseClaim(sessionId: SessionId, workerId: string): Promise<void>;
  /** The current live claim, if any (expired leases read as absent). */
  getClaim(sessionId: SessionId): Promise<RunClaim | undefined>;
}

export function hasRunClaims(store: SessionStore): store is RunClaimStore {
  const candidate = store as Partial<RunClaimStore>;

  return (
    typeof candidate.claimRun === "function" &&
    typeof candidate.renewClaim === "function" &&
    typeof candidate.releaseClaim === "function" &&
    typeof candidate.getClaim === "function"
  );
}

export function hasSessionProjections(store: SessionStore): store is SessionProjectionStore {
  const candidate = store as Partial<SessionProjectionStore>;

  return (
    typeof candidate.listSessions === "function" &&
    typeof candidate.getSessionSummary === "function" &&
    typeof candidate.listForks === "function"
  );
}

export function deriveSessionSummary(
  session: SessionRecord,
  options: { createdAt?: string } = {}
): SessionSummary {
  const createdAt =
    options.createdAt ??
    session.createdAt ??
    session.events[0]?.createdAt ??
    new Date(0).toISOString();
  const latestEventAt = session.events.at(-1)?.createdAt;
  const started = session.events.find((event) => event.type === "session.started");

  return {
    id: session.id,
    metadata: session.metadata,
    createdAt,
    latestEventAt,
    eventCount: session.events.length,
    status: deriveSessionStatus(session.events),
    profileName:
      typeof session.metadata?.profileName === "string"
        ? session.metadata.profileName
        : started?.type === "session.started"
          ? started.profileName
          : undefined,
    profilePath:
      typeof session.metadata?.profilePath === "string"
        ? session.metadata.profilePath
        : undefined,
    preview: deriveSessionPreview(session.events)
  };
}

/**
 * Lifecycle events that decide a session's status, newest wins. Harness runs
 * emit `run.*`; staged workflow parents never run a harness, so their
 * orchestration events participate too (a finished workflow reads as
 * completed, a dispatched or approval-gated one as paused).
 */
export const sessionLifecycleEventTypes = [
  "run.completed",
  "run.paused",
  "run.failed",
  "run.started",
  "workflow.run.completed",
  "workflow.run.started",
  "workflow.stage.started",
  "workflow.stage.dispatched",
  "human.approval.requested",
  "human.approval.granted",
  "human.approval.denied"
] as const;

export function deriveSessionStatus(events: SessionEvent[]): SessionStatus {
  const lifecycle = [...events]
    .reverse()
    .find((event) => (sessionLifecycleEventTypes as readonly string[]).includes(event.type));

  if (!lifecycle) {
    return "new";
  }

  switch (lifecycle.type) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.paused":
      return "paused";
    case "run.started":
      return "running";
    case "workflow.run.completed":
      return lifecycle.status === "completed" ? "completed" : "failed";
    case "workflow.stage.dispatched":
    case "human.approval.requested":
    case "human.approval.denied":
      return "paused";
    default:
      return "running";
  }
}

export function deriveSessionPreview(events: SessionEvent[]): string | undefined {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "message.user" || candidate.type === "message.assistant");

  if (!event || (event.type !== "message.user" && event.type !== "message.assistant")) {
    return undefined;
  }

  return event.content.replace(/\s+/g, " ").slice(0, 120);
}

export function deriveForkSummaries(sessions: SessionRecord[]): ForkSummary[] {
  return sessions.flatMap((session) =>
    session.events
      .filter((event) => event.type === "session.forked")
      .map((event) => ({
        sessionId: session.id,
        forkedFromSessionId: event.fromSessionId,
        atOffset: event.atOffset,
        createdAt: event.createdAt
      }))
  );
}

export async function appendEvent(
  store: SessionStore,
  sessionId: SessionId,
  event: NewSessionEvent,
  options?: AppendEventOptions
): Promise<SessionEvent> {
  return store.appendEvent(sessionId, event, options);
}

export async function getSession(
  store: SessionStore,
  sessionId: SessionId,
  options?: GetSessionOptions
): Promise<SessionRecord> {
  return store.getSession(sessionId, options);
}

export async function fork(
  store: SessionStore,
  sessionId: SessionId,
  atOffset: number,
  options?: ForkSessionOptions
): Promise<SessionId> {
  return store.fork(sessionId, atOffset, options);
}
