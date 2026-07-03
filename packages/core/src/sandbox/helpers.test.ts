import { expect, test } from "bun:test";
import {
  SANDBOX_TRUNCATION_MARKER,
  capText,
  effectiveLimit,
  isCleanupDeferred,
  readStreamCapped,
  shouldCleanup
} from "./helpers";

test("effectiveLimit treats policy as a cap, not a default", () => {
  // No policy cap: request or fallback wins.
  expect(effectiveLimit(undefined, undefined, 30_000)).toBe(30_000);
  expect(effectiveLimit(5_000, undefined, 30_000)).toBe(5_000);
  // Policy cap set: requests may tighten, never loosen.
  expect(effectiveLimit(undefined, 10_000, 30_000)).toBe(10_000);
  expect(effectiveLimit(5_000, 10_000, 30_000)).toBe(5_000);
  expect(effectiveLimit(60_000, 10_000, 30_000)).toBe(10_000);
});

test("shouldCleanup and isCleanupDeferred follow the cleanup policy", () => {
  expect(shouldCleanup({ kind: "local" })).toBe(true);
  expect(shouldCleanup({ kind: "local", cleanup: "always" })).toBe(true);
  expect(shouldCleanup({ kind: "local", cleanup: "never" })).toBe(false);
  expect(shouldCleanup({ kind: "local", cleanup: "on-success" })).toBe(false);
  expect(shouldCleanup({ kind: "local", cleanup: "on-success" }, { outcome: "success" })).toBe(
    true
  );
  expect(shouldCleanup({ kind: "local", cleanup: "on-success" }, { outcome: "failure" })).toBe(
    false
  );

  expect(isCleanupDeferred({ kind: "local", cleanup: "on-success" })).toBe(true);
  expect(isCleanupDeferred({ kind: "local", cleanup: "on-success" }, { outcome: "failure" })).toBe(
    false
  );
  expect(isCleanupDeferred({ kind: "local", cleanup: "never" })).toBe(false);
});

test("capText caps by bytes and appends the truncation marker", () => {
  expect(capText("short", 64_000)).toEqual({ value: "short", truncated: false });
  expect(capText("abcdefghijklmnop", 12)).toEqual({
    value: SANDBOX_TRUNCATION_MARKER,
    truncated: true
  });

  const capped = capText("a".repeat(100), 50);
  expect(capped.truncated).toBe(true);
  expect(capped.value).toBe("a".repeat(50 - SANDBOX_TRUNCATION_MARKER.length) + SANDBOX_TRUNCATION_MARKER);
});

test("capText never splits a multi-byte character", () => {
  // "é" is 2 bytes in UTF-8; budget of 21 bytes leaves 7 for content, which
  // would split the fourth "é" without boundary handling.
  const capped = capText("é".repeat(50), 21);

  expect(capped.truncated).toBe(true);
  expect(capped.value).toBe("ééé" + SANDBOX_TRUNCATION_MARKER);
  expect(capped.value.includes("�")).toBe(false);
});

test("readStreamCapped retains up to the cap and keeps draining", async () => {
  let pulls = 0;
  const chunk = new TextEncoder().encode("x".repeat(1_000));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;

      if (pulls > 100) {
        controller.close();
        return;
      }

      controller.enqueue(chunk);
    }
  });

  const result = await readStreamCapped(stream, 2_000);

  // The whole stream was drained (the producer was not left blocked) ...
  expect(pulls).toBeGreaterThan(100);
  // ... but only the cap was retained.
  expect(result.truncated).toBe(true);
  expect(result.value).toBe(
    "x".repeat(2_000 - SANDBOX_TRUNCATION_MARKER.length) + SANDBOX_TRUNCATION_MARKER
  );
});

test("readStreamCapped returns full content under the cap", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello "));
      controller.enqueue(new TextEncoder().encode("world"));
      controller.close();
    }
  });

  expect(await readStreamCapped(stream, 64_000)).toEqual({
    value: "hello world",
    truncated: false
  });
  expect(await readStreamCapped(null, 64_000)).toEqual({ value: "", truncated: false });
});

test("readStreamCapped is UTF-8 safe across chunk boundaries at the cap", async () => {
  const bytes = new TextEncoder().encode("π".repeat(20)); // 2 bytes each
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });

  // Cap of 29 leaves a 15-byte budget after the marker: 7 full "π" plus one
  // dangling lead byte, which must be dropped rather than mangled.
  const result = await readStreamCapped(stream, 29);

  expect(result.truncated).toBe(true);
  expect(result.value).toBe("π".repeat(7) + SANDBOX_TRUNCATION_MARKER);
  expect(result.value.includes("�")).toBe(false);
});
