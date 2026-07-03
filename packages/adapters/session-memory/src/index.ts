import {
  createEventId,
  createTimestamp,
  deriveForkSummaries,
  deriveSessionSummary,
  sessionEventSchema,
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
  type SessionStore,
  type SessionStoreCapabilities,
  type SessionSummary,
  type SubscribeOptions
} from "@oma/core";

type Subscriber = {
  onEvent: (event: SessionEvent) => void;
};

type SessionState = {
  events: SessionEvent[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  idempotency: Map<string, SessionEvent>;
};

export class MemorySessionStore implements SessionStore, SessionProjectionStore, RunClaimStore {
  private sessions = new Map<SessionId, SessionState>();
  private subscribers = new Map<SessionId, Set<Subscriber>>();
  private claims = new Map<SessionId, { workerId: string; expiresAt: number }>();

  capabilities(): SessionStoreCapabilities {
    return {
      durable: false,
      crossProcessSubscribe: false,
      efficientFork: true,
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
    const existing = this.claims.get(sessionId);

    if (existing && existing.expiresAt > Date.now() && existing.workerId !== workerId) {
      return undefined;
    }

    const expiresAt = Date.now() + ttlMs;
    this.claims.set(sessionId, { workerId, expiresAt });
    return { sessionId, workerId, expiresAt: new Date(expiresAt).toISOString() };
  }

  async renewClaim(sessionId: SessionId, workerId: string, ttlMs: number): Promise<boolean> {
    const existing = this.claims.get(sessionId);

    if (!existing || existing.workerId !== workerId || existing.expiresAt <= Date.now()) {
      return false;
    }

    existing.expiresAt = Date.now() + ttlMs;
    return true;
  }

  async releaseClaim(sessionId: SessionId, workerId: string): Promise<void> {
    if (this.claims.get(sessionId)?.workerId === workerId) {
      this.claims.delete(sessionId);
    }
  }

  async getClaim(sessionId: SessionId): Promise<RunClaim | undefined> {
    const existing = this.claims.get(sessionId);

    if (!existing || existing.expiresAt <= Date.now()) {
      return undefined;
    }

    return {
      sessionId,
      workerId: existing.workerId,
      expiresAt: new Date(existing.expiresAt).toISOString()
    };
  }

  async createSession(options: CreateSessionOptions = {}): Promise<SessionId> {
    const id = options.id ?? crypto.randomUUID();

    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }

    this.sessions.set(id, {
      events: [],
      metadata: options.metadata,
      createdAt: createTimestamp(),
      idempotency: new Map()
    });

    return id;
  }

  async exists(sessionId: SessionId): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async appendEvent(
    sessionId: SessionId,
    event: NewSessionEvent,
    options: AppendEventOptions = {}
  ): Promise<SessionEvent> {
    const state = this.requireSession(sessionId);

    if (options.idempotencyKey) {
      const existing = state.idempotency.get(options.idempotencyKey);

      if (existing) {
        return existing;
      }
    }

    if (
      options.expectedOffset !== undefined &&
      options.expectedOffset !== state.events.length
    ) {
      throw new Error(
        `Expected offset ${options.expectedOffset}, got ${state.events.length}`
      );
    }

    const parsed = Object.freeze(
      sessionEventSchema.parse({
        ...event,
        id: createEventId(),
        sessionId,
        offset: state.events.length,
        createdAt: createTimestamp()
      })
    );

    state.events.push(parsed);

    if (options.idempotencyKey) {
      state.idempotency.set(options.idempotencyKey, parsed);
    }

    this.publish(sessionId, parsed);
    return parsed;
  }

  async getSession(
    sessionId: SessionId,
    options: GetSessionOptions = {}
  ): Promise<SessionRecord> {
    const state = this.requireSession(sessionId);
    const fromOffset = options.fromOffset ?? 0;

    return {
      id: sessionId,
      metadata: state.metadata,
      createdAt: state.createdAt,
      events: state.events.filter((event) => event.offset >= fromOffset)
    };
  }

  subscribe(
    sessionId: SessionId,
    options: SubscribeOptions = {}
  ): AsyncIterable<SessionEvent> {
    const state = this.requireSession(sessionId);
    const fromOffset = options.fromOffset ?? 0;
    const historical = state.events.filter((event) => event.offset >= fromOffset);
    const queue: SessionEvent[] = [...historical];
    const waiters: Array<(value: IteratorResult<SessionEvent>) => void> = [];
    let closed = false;

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

    const subscriber: Subscriber = {
      onEvent: (event) => {
        if (event.offset < fromOffset) {
          return;
        }

        if (waiters.length > 0) {
          waiters.shift()?.({ done: false, value: event });
          return;
        }

        queue.push(event);
      }
    };

    const subscribers = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);

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
    const state = this.requireSession(sessionId);

    if (!state.events.some((event) => event.offset === atOffset)) {
      throw new Error(`Offset not found: ${atOffset}`);
    }

    const newSessionId = options.id ?? crypto.randomUUID();

    if (this.sessions.has(newSessionId)) {
      throw new Error(`Session already exists: ${newSessionId}`);
    }

    // Copies keep the source payload and createdAt; only ids change (uniqueness).
    const forked = state.events
      .filter((event) => event.offset <= atOffset)
      .map((event, offset) =>
        Object.freeze(
          sessionEventSchema.parse({
            ...event,
            id: createEventId(),
            sessionId: newSessionId,
            offset
          })
        )
      );
    // The fork marker lands in the same synchronous block as the copy, so a
    // fork is never visible without its provenance.
    const marker = Object.freeze(
      sessionEventSchema.parse({
        type: "session.forked",
        fromSessionId: sessionId,
        atOffset,
        id: createEventId(),
        sessionId: newSessionId,
        offset: forked.length,
        createdAt: createTimestamp()
      })
    );

    this.sessions.set(newSessionId, {
      events: [...forked, marker],
      metadata: options.metadata ?? state.metadata,
      createdAt: createTimestamp(),
      idempotency: new Map()
    });
    this.publish(newSessionId, marker);

    return newSessionId;
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const summaries = [...this.sessions.entries()]
      .map(([id, state]) =>
        deriveSessionSummary({
          id,
          metadata: state.metadata,
          createdAt: state.createdAt,
          events: state.events
        })
      )
      .sort((left, right) =>
        (right.latestEventAt ?? right.createdAt).localeCompare(left.latestEventAt ?? left.createdAt)
      );

    return typeof options.limit === "number" ? summaries.slice(0, options.limit) : summaries;
  }

  async getSessionSummary(sessionId: SessionId): Promise<SessionSummary> {
    const state = this.requireSession(sessionId);

    return deriveSessionSummary({
      id: sessionId,
      metadata: state.metadata,
      createdAt: state.createdAt,
      events: state.events
    });
  }

  async listForks(sessionId: SessionId): Promise<ForkSummary[]> {
    const sessions = [...this.sessions.entries()].map(([id, state]) => ({
      id,
      metadata: state.metadata,
      createdAt: state.createdAt,
      events: state.events
    }));

    return deriveForkSummaries(sessions).filter(
      (fork) => fork.sessionId === sessionId || fork.forkedFromSessionId === sessionId
    );
  }

  private requireSession(sessionId: SessionId): SessionState {
    const state = this.sessions.get(sessionId);

    if (!state) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return state;
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
