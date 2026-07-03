import type { RunClaimStore } from "../session/store";

export interface WakeLock {
  withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
}

/** Another live worker holds the session's run claim. */
export class ClaimHeldError extends Error {
  constructor(
    readonly sessionId: string,
    readonly heldBy: string,
    readonly expiresAt: string
  ) {
    super(`Session ${sessionId} is claimed by ${heldBy} until ${expiresAt}.`);
    this.name = "ClaimHeldError";
  }
}

export interface ClaimWakeLockOptions {
  /** Lease duration; renewed at ttlMs/3 while the work runs. Default 30s. */
  ttlMs?: number;
  /**
   * Extra liveness check for refused claims: return true when the holder is
   * provably dead (e.g. a local CLI pid that no longer exists) to take over
   * immediately instead of waiting for the lease to expire.
   */
  isStale?(claim: { workerId: string; expiresAt: string }): Promise<boolean> | boolean;
}

/**
 * The durable wake lock: in-process calls for the same session queue (like
 * MemoryWakeLock), and across processes a store-backed lease guarantees a
 * single worker makes progress. A crashed holder's lease expires and any
 * worker takes over — the log replays, so takeover is safe by construction.
 */
export class ClaimWakeLock implements WakeLock {
  private readonly inner = new MemoryWakeLock();
  private readonly ttlMs: number;
  private readonly isStale?: ClaimWakeLockOptions["isStale"];

  constructor(
    private readonly store: RunClaimStore,
    private readonly workerId: string,
    options: ClaimWakeLockOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.isStale = options.isStale;
  }

  async withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    return this.inner.withSessionLock(sessionId, async () => {
      let claim = await this.store.claimRun(sessionId, this.workerId, this.ttlMs);

      if (!claim) {
        const holder = await this.store.getClaim(sessionId);

        if (holder && this.isStale && (await this.isStale(holder))) {
          // The holder is provably dead: break its lease and take over now.
          await this.store.releaseClaim(sessionId, holder.workerId);
          claim = await this.store.claimRun(sessionId, this.workerId, this.ttlMs);
        }

        if (!claim) {
          throw new ClaimHeldError(
            sessionId,
            holder?.workerId ?? "another worker",
            holder?.expiresAt ?? "its lease expires"
          );
        }
      }

      const heartbeat = setInterval(() => {
        void this.store.renewClaim(sessionId, this.workerId, this.ttlMs).catch(() => {
          // A failed renewal means the lease may lapse; the work itself stays
          // correct (replay), so renewal errors are not fatal here.
        });
      }, Math.max(1_000, Math.floor(this.ttlMs / 3)));

      try {
        return await run();
      } finally {
        clearInterval(heartbeat);
        await this.store.releaseClaim(sessionId, this.workerId).catch(() => undefined);
      }
    });
  }
}

export class MemoryWakeLock implements WakeLock {
  private tails = new Map<string, Promise<void>>();

  async withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = tail.catch(() => undefined).then(() => next);

    this.tails.set(sessionId, chained);

    await tail.catch(() => undefined);

    try {
      return await run();
    } finally {
      release();

      if (this.tails.get(sessionId) === chained) {
        this.tails.delete(sessionId);
      }
    }
  }
}
