import { expect, test } from "bun:test";
import type { SessionEvent } from "./events";
import {
  hasRunClaims,
  hasSessionProjections,
  sessionStoreCapabilities,
  type SessionProjectionStore,
  type SessionStore,
  type SessionStoreCapabilities
} from "./store";

export function runSessionStoreContractTests(
  name: string,
  makeStore: () => SessionStore
): void {
  test(`${name}: creates sessions and reports existence`, async () => {
    const store = makeStore();
    const sessionA = contractSessionId("session-a");

    expect(await store.exists(sessionA)).toBe(false);
    const sessionId = await store.createSession({ id: sessionA });

    expect(sessionId).toBe(sessionA);
    expect(await store.exists(sessionA)).toBe(true);
    await expect(store.createSession({ id: sessionA })).rejects.toThrow();
  });

  test(`${name}: rejects missing sessions and malformed events`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    await expect(
      store.appendEvent("missing", { type: "system.note", message: "bad" })
    ).rejects.toThrow();
    await expect(
      store.appendEvent(sessionId, { type: "not.real" } as never)
    ).rejects.toThrow();
  });

  test(`${name}: appends contiguous events and enforces expectedOffset`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    const first = await store.appendEvent(
      sessionId,
      { type: "system.note", message: "one" },
      { expectedOffset: 0 }
    );
    const second = await store.appendEvent(
      sessionId,
      { type: "system.note", message: "two" },
      { expectedOffset: 1 }
    );

    expect(first.offset).toBe(0);
    expect(second.offset).toBe(1);
    await expect(
      store.appendEvent(sessionId, { type: "system.note", message: "bad" }, { expectedOffset: 1 })
    ).rejects.toThrow();
  });

  test(`${name}: supports idempotent append`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    const first = await store.appendEvent(
      sessionId,
      { type: "system.note", message: "one" },
      { idempotencyKey: "note:one" }
    );
    const repeated = await store.appendEvent(
      sessionId,
      { type: "system.note", message: "duplicate" },
      { idempotencyKey: "note:one" }
    );

    expect(repeated.id).toBe(first.id);
    expect(repeated.offset).toBe(first.offset);
    expect((await store.getSession(sessionId)).events).toHaveLength(1);
  });

  test(`${name}: slices sessions from offset`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });
    await store.appendEvent(sessionId, { type: "system.note", message: "one" });

    const sliced = await store.getSession(sessionId, { fromOffset: 1 });

    expect(sliced.events.map((event) => event.offset)).toEqual([1]);
  });

  test(`${name}: subscribes to historical and live events`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });
    await store.appendEvent(sessionId, { type: "system.note", message: "one" });

    const controller = new AbortController();
    const iterator = store
      .subscribe(sessionId, { fromOffset: 1, signal: controller.signal })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value).toMatchObject({
      type: "system.note",
      offset: 1
    });

    const live = iterator.next();
    await store.appendEvent(sessionId, { type: "system.note", message: "two" });

    expect((await live).value).toMatchObject({
      type: "system.note",
      offset: 2
    });

    controller.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  test(`${name}: forks through an offset and keeps fork independent`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });
    const forkSessionId = contractSessionId("session-b");

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });
    await store.appendEvent(sessionId, { type: "system.note", message: "one" });
    await expect(store.fork(sessionId, 5, { id: contractSessionId("bad-fork") })).rejects.toThrow();

    const forkId = await store.fork(sessionId, 1, { id: forkSessionId });
    await store.appendEvent(forkId, { type: "system.note", message: "fork-only" });

    const original = await store.getSession(sessionId);
    const forked = await store.getSession(forkId);

    expect(original.events).toHaveLength(2);
    expect(forked.events.map((event) => event.offset)).toEqual([0, 1, 2, 3]);
    expect(forked.events[2]).toMatchObject({
      type: "session.forked",
      fromSessionId: sessionId,
      atOffset: 1
    });
  });

  test(`${name}: subscribe hands off from replay to live without gaps or duplicates`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });
    await store.appendEvent(sessionId, { type: "system.note", message: "one" });

    const controller = new AbortController();
    const iterator = store
      .subscribe(sessionId, { fromOffset: 0, signal: controller.signal })
      [Symbol.asyncIterator]();

    try {
      // Append immediately, without draining the replayed history first.
      await store.appendEvent(sessionId, { type: "system.note", message: "two" });
      await store.appendEvent(sessionId, { type: "system.note", message: "three" });

      const offsets: number[] = [];

      for (let index = 0; index < 4; index += 1) {
        const result = await nextWithTimeout(iterator, 5_000);

        expect(result.done).toBe(false);
        offsets.push(result.value!.offset);
      }

      expect(offsets).toEqual([0, 1, 2, 3]);
    } finally {
      controller.abort();
    }
  });

  test(`${name}: concurrent appends with expectedOffset admit exactly one writer`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    const results = await Promise.allSettled([
      store.appendEvent(
        sessionId,
        { type: "system.note", message: "one" },
        { expectedOffset: 0 }
      ),
      store.appendEvent(
        sessionId,
        { type: "system.note", message: "two" },
        { expectedOffset: 0 }
      )
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((await store.getSession(sessionId)).events).toHaveLength(1);
  });

  test(`${name}: fork and parent stay independent in both directions`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({
      id: contractSessionId("session-a"),
      metadata: { profilePath: "profiles/example/profile.json" }
    });

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });
    await store.appendEvent(sessionId, { type: "system.note", message: "one" });

    const forkId = await store.fork(sessionId, 0, { id: contractSessionId("session-b") });

    await store.appendEvent(sessionId, { type: "system.note", message: "parent-only" });
    await store.appendEvent(forkId, { type: "system.note", message: "fork-only" });

    const parent = await store.getSession(sessionId);
    const forked = await store.getSession(forkId);

    expect(parent.events.map((event) => event.offset)).toEqual([0, 1, 2]);
    expect(parent.events.some((event) => event.type === "session.forked")).toBe(false);
    expect(parent.events.at(-1)).toMatchObject({ type: "system.note", message: "parent-only" });
    expect(forked.events.map((event) => event.offset)).toEqual([0, 1, 2]);
    expect(forked.events[1]).toMatchObject({
      type: "session.forked",
      fromSessionId: sessionId,
      atOffset: 0
    });
    expect(forked.events.at(-1)).toMatchObject({ type: "system.note", message: "fork-only" });
    expect(forked.metadata).toEqual({ profilePath: "profiles/example/profile.json" });
  });

  test(`${name}: fork copies preserve payload and createdAt with fresh ids`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });
    const original = await store.appendEvent(sessionId, {
      type: "system.note",
      message: "zero"
    });

    // Make sure a rewritten timestamp would actually differ from the original.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const forkId = await store.fork(sessionId, 0, { id: contractSessionId("session-b") });
    const forked = await store.getSession(forkId);

    expect(forked.events[0]).toMatchObject({
      type: "system.note",
      message: "zero",
      offset: 0,
      createdAt: original.createdAt
    });
    expect(forked.events[0]!.id).not.toBe(original.id);
  });

  test(`${name}: subscribing to a missing session rejects`, async () => {
    const store = makeStore();

    await expect(
      (async () => {
        const iterator = store.subscribe("missing-session")[Symbol.asyncIterator]();
        return await nextWithTimeout(iterator, 5_000);
      })()
    ).rejects.toThrow("Session not found");
  });

  test(`${name}: mutating a returned event does not corrupt the log`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });
    const appended = await store.appendEvent(sessionId, {
      type: "system.note",
      message: "original"
    });

    try {
      (appended as { message: string }).message = "mutated";
    } catch {
      // Frozen events throw on mutation; that is fine too.
    }

    expect((await store.getSession(sessionId)).events[0]).toMatchObject({
      type: "system.note",
      message: "original"
    });
  });

  test(`${name}: an already-aborted signal closes the subscription immediately`, async () => {
    const store = makeStore();
    const sessionId = await store.createSession({ id: contractSessionId("session-a") });

    await store.appendEvent(sessionId, { type: "system.note", message: "zero" });

    const controller = new AbortController();
    controller.abort();

    const iterator = store
      .subscribe(sessionId, { fromOffset: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    const result = await nextWithTimeout(iterator, 2_000);

    expect(result.done).toBe(true);
  });
}

async function nextWithTimeout(
  iterator: AsyncIterator<SessionEvent>,
  timeoutMs: number
): Promise<IteratorResult<SessionEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for the next event after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function runSessionStoreCapabilityContractTests(
  name: string,
  makeStore: () => SessionStore,
  expected: SessionStoreCapabilities
): void {
  test(`${name}: reports store capabilities`, () => {
    const store = makeStore();

    expect(sessionStoreCapabilities(store)).toEqual(expected);
  });
}

export function runSessionProjectionContractTests(
  name: string,
  makeStore: () => SessionStore
): void {
  test(`${name}: projects session summaries and fork summaries`, async () => {
    const store = makeStore();
    const sessionA = contractSessionId("session-a");
    const sessionB = contractSessionId("session-b");

    if (!hasSessionProjections(store)) {
      throw new Error(`${name} does not implement SessionProjectionStore`);
    }

    const projectionStore: SessionProjectionStore = store;
    const sessionId = await projectionStore.createSession({
      id: sessionA,
      metadata: { profilePath: "profiles/example/profile.json" }
    });

    await projectionStore.appendEvent(sessionId, {
      type: "session.started",
      profileName: "example",
      mode: "interactive"
    });
    await projectionStore.appendEvent(sessionId, {
      type: "message.user",
      content: "please inspect this repository"
    });
    await projectionStore.appendEvent(sessionId, { type: "run.started", runId: "run-1" });
    await projectionStore.appendEvent(sessionId, {
      type: "message.assistant",
      content: "I found the shape of the repo."
    });
    await projectionStore.appendEvent(sessionId, {
      type: "run.paused",
      runId: "run-1",
      steps: 3,
      reason: "max_steps"
    });

    const forkId = await projectionStore.fork(sessionId, 1, { id: sessionB });
    const summary = await projectionStore.getSessionSummary(sessionId);
    const sessions = await projectionStore.listSessions();
    const limited = await projectionStore.listSessions({ limit: 1 });
    const forks = await projectionStore.listForks(sessionId);

    expect(summary).toMatchObject({
      id: sessionId,
      eventCount: 5,
      status: "paused",
      profileName: "example",
      profilePath: "profiles/example/profile.json",
      preview: "I found the shape of the repo."
    });
    expect(typeof summary.createdAt).toBe("string");
    expect(typeof summary.latestEventAt).toBe("string");
    // Timestamps come back in ISO format on every adapter.
    expect(new Date(summary.createdAt).toISOString()).toBe(summary.createdAt);
    expect(new Date(summary.latestEventAt!).toISOString()).toBe(summary.latestEventAt!);
    expect(sessions.map((session) => session.id)).toContain(sessionId);
    expect(sessions.map((session) => session.id)).toContain(forkId);
    expect(limited).toHaveLength(1);
    expect(forks).toContainEqual(
      expect.objectContaining({
        sessionId: forkId,
        forkedFromSessionId: sessionId,
        atOffset: 1
      })
    );
  });
}

export function runCrossProcessSubscribeContractTest(
  name: string,
  makeStores: () => { subscriber: SessionStore; appender: SessionStore }
): void {
  test(`${name}: observes appends from another store instance`, async () => {
    const { subscriber, appender } = makeStores();
    const sessionId = await appender.createSession({ id: contractSessionId("session-a") });
    const controller = new AbortController();
    const iterator = subscriber
      .subscribe(sessionId, { fromOffset: 0, signal: controller.signal })
      [Symbol.asyncIterator]();
    const live = iterator.next();

    await appender.appendEvent(sessionId, { type: "system.note", message: "cross-process" });

    try {
      const observed = await Promise.race([
        live,
        new Promise<IteratorResult<unknown>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 2_000)
        )
      ]);

      expect(observed.done).toBe(false);
      expect(observed.value).toMatchObject({
        type: "system.note",
        message: "cross-process"
      });
    } finally {
      controller.abort();
    }
  });
}

function contractSessionId(label: string): string {
  return `contract:${label}:${crypto.randomUUID()}`;
}

export function runRunClaimContractTests(
  name: string,
  makeStore: () => SessionStore
): void {
  const requireClaims = (store: SessionStore) => {
    if (!hasRunClaims(store)) {
      throw new Error(`${name} does not implement RunClaimStore`);
    }

    return store;
  };

  test(`${name}: claims are exclusive until released`, async () => {
    const store = requireClaims(makeStore());
    const sessionId = await store.createSession({ id: contractSessionId("claim-a") });

    const claim = await store.claimRun(sessionId, "worker-1", 60_000);
    expect(claim).toMatchObject({ sessionId, workerId: "worker-1" });
    expect(Date.parse(claim!.expiresAt)).toBeGreaterThan(Date.now());

    // Another worker is refused while the lease is live.
    expect(await store.claimRun(sessionId, "worker-2", 60_000)).toBeUndefined();

    // The holder can re-claim (idempotent) and read the claim back.
    expect(await store.claimRun(sessionId, "worker-1", 60_000)).toMatchObject({
      workerId: "worker-1"
    });
    expect(await store.getClaim(sessionId)).toMatchObject({ workerId: "worker-1" });

    await store.releaseClaim(sessionId, "worker-1");
    expect(await store.getClaim(sessionId)).toBeUndefined();
    expect(await store.claimRun(sessionId, "worker-2", 60_000)).toMatchObject({
      workerId: "worker-2"
    });
  });

  test(`${name}: renewal extends a held lease and refuses strangers`, async () => {
    const store = requireClaims(makeStore());
    const sessionId = await store.createSession({ id: contractSessionId("claim-b") });

    await store.claimRun(sessionId, "worker-1", 60_000);
    expect(await store.renewClaim(sessionId, "worker-1", 120_000)).toBe(true);
    expect(await store.renewClaim(sessionId, "worker-2", 120_000)).toBe(false);

    // Releasing with the wrong worker id is a no-op.
    await store.releaseClaim(sessionId, "worker-2");
    expect(await store.getClaim(sessionId)).toMatchObject({ workerId: "worker-1" });
  });

  test(`${name}: expired leases are recoverable by other workers`, async () => {
    const store = requireClaims(makeStore());
    const sessionId = await store.createSession({ id: contractSessionId("claim-c") });

    await store.claimRun(sessionId, "worker-1", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The dead worker's lease has expired: reads as absent, claimable anew.
    expect(await store.getClaim(sessionId)).toBeUndefined();
    expect(await store.claimRun(sessionId, "worker-2", 60_000)).toMatchObject({
      workerId: "worker-2"
    });
    expect(await store.renewClaim(sessionId, "worker-1", 60_000)).toBe(false);
  });
}
