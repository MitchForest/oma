import { expect, test } from "bun:test";
import type { RunClaim, RunClaimStore } from "../session/store";
import { ClaimHeldError, ClaimWakeLock } from "./wake-lock";

/** Claims-only stub: the lock never touches session APIs. */
function claimStore(): RunClaimStore {
  const claims = new Map<string, { workerId: string; expiresAt: number }>();

  return {
    async claimRun(sessionId, workerId, ttlMs): Promise<RunClaim | undefined> {
      const existing = claims.get(sessionId);

      if (existing && existing.expiresAt > Date.now() && existing.workerId !== workerId) {
        return undefined;
      }

      const expiresAt = Date.now() + ttlMs;
      claims.set(sessionId, { workerId, expiresAt });
      return { sessionId, workerId, expiresAt: new Date(expiresAt).toISOString() };
    },
    async renewClaim(sessionId, workerId, ttlMs) {
      const existing = claims.get(sessionId);

      if (!existing || existing.workerId !== workerId || existing.expiresAt <= Date.now()) {
        return false;
      }

      existing.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async releaseClaim(sessionId, workerId) {
      if (claims.get(sessionId)?.workerId === workerId) {
        claims.delete(sessionId);
      }
    },
    async getClaim(sessionId) {
      const existing = claims.get(sessionId);

      if (!existing || existing.expiresAt <= Date.now()) {
        return undefined;
      }

      return {
        sessionId,
        workerId: existing.workerId,
        expiresAt: new Date(existing.expiresAt).toISOString()
      };
    }
  } as RunClaimStore;
}

test("in-process calls queue; cross-worker calls are refused while held", async () => {
  const store = claimStore();
  const lockA = new ClaimWakeLock(store, "worker-a");
  const lockB = new ClaimWakeLock(store, "worker-b");
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = lockA.withSessionLock("s1", async () => {
    order.push("first-start");
    await gate;
    order.push("first-end");
    return 1;
  });
  // Give the first claim time to land before contending.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Same process, same lock: queues behind the first.
  const second = lockA.withSessionLock("s1", async () => {
    order.push("second");
    return 2;
  });

  // Another worker: refused with the holder named.
  await expect(lockB.withSessionLock("s1", async () => 3)).rejects.toThrow(ClaimHeldError);

  releaseFirst();
  expect(await first).toBe(1);
  expect(await second).toBe(2);
  expect(order).toEqual(["first-start", "first-end", "second"]);

  // Released after completion: the other worker can now claim.
  expect(await lockB.withSessionLock("s1", async () => 3)).toBe(3);
});

test("an expired lease is taken over by another worker", async () => {
  const store = claimStore();

  // Simulate a crashed holder: claim taken, never released, tiny TTL.
  await store.claimRun("s1", "dead-worker", 5);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const lock = new ClaimWakeLock(store, "worker-b");
  expect(await lock.withSessionLock("s1", async () => "recovered")).toBe("recovered");
});

test("a provably dead holder's lease is broken via isStale", async () => {
  const store = claimStore();

  await store.claimRun("s1", "cli:host:99999", 60_000);

  const refused = new ClaimWakeLock(store, "worker-b");
  await expect(refused.withSessionLock("s1", async () => 1)).rejects.toThrow(ClaimHeldError);

  const takeover = new ClaimWakeLock(store, "worker-b", {
    isStale: (claim) => claim.workerId.startsWith("cli:")
  });
  expect(await takeover.withSessionLock("s1", async () => "stolen")).toBe("stolen");
});
