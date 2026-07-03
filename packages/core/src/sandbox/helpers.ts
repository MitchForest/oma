import type { SandboxDestroyOptions, SandboxPolicy } from "./sandbox";

export const SANDBOX_TRUNCATION_MARKER = "...[truncated]";

export interface CappedText {
  value: string;
  truncated: boolean;
}

/**
 * Whether a sandbox destroy should clean up the underlying resource for the
 * given policy and outcome. With `cleanup: "on-success"` and no outcome the
 * answer is "not yet" — adapters must keep the resource destroyable so a later
 * destroy that carries an outcome can decide.
 */
export function shouldCleanup(
  policy: SandboxPolicy,
  options: SandboxDestroyOptions = {}
): boolean {
  if (policy.cleanup === "never") {
    return false;
  }

  if (policy.cleanup === "on-success") {
    return options.outcome === "success";
  }

  return true;
}

/**
 * Whether a destroy that decided not to clean up should still be considered
 * final. With `cleanup: "on-success"` and no outcome the resource must not be
 * permanently stranded: the destroy is deferred until an outcome arrives.
 */
export function isCleanupDeferred(
  policy: SandboxPolicy,
  options: SandboxDestroyOptions = {}
): boolean {
  return policy.cleanup === "on-success" && options.outcome === undefined;
}

/**
 * Resolve the effective limit for an exec request. Policy is a cap, not a
 * default: requests may tighten it but never loosen it. When the policy does
 * not set the limit, the request value (or the adapter fallback) applies.
 */
export function effectiveLimit(
  requested: number | undefined,
  policyCap: number | undefined,
  fallback: number
): number {
  if (policyCap === undefined) {
    return requested ?? fallback;
  }

  return requested === undefined ? policyCap : Math.min(requested, policyCap);
}

/**
 * Cap a string to `maxBytes` of UTF-8, appending the truncation marker when
 * content is dropped. Never splits a multi-byte character.
 */
export function capText(value: string, maxBytes: number): CappedText {
  const encoded = new TextEncoder().encode(value);

  if (encoded.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  return { value: finishTruncated(encoded, maxBytes), truncated: true };
}

/**
 * Read a stream incrementally, retaining at most `maxBytes` of it. Once past
 * the cap the result is marked truncated but the stream keeps draining so the
 * producing child process never blocks on a full pipe.
 *
 * An optional `signal` stops reading early and resolves with what was
 * retained — used when a surviving grandchild process holds the pipe open
 * after the spawned child already exited.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  signal?: AbortSignal
): Promise<CappedText> {
  if (!stream) {
    return { value: "", truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  const reader = stream.getReader();
  const cancelRead = (): void => {
    reader.cancel().catch(() => {});
  };

  if (signal?.aborted) {
    cancelRead();
  } else {
    signal?.addEventListener("abort", cancelRead, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      const room = maxBytes - retainedBytes;

      if (room > 0) {
        const piece = value.byteLength <= room ? value : value.slice(0, room);
        chunks.push(piece);
        retainedBytes += piece.byteLength;
      }
      // Past the cap: stop retaining but keep draining.
    }
  } finally {
    signal?.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }

  const retained = concatChunks(chunks, retainedBytes);

  if (totalBytes <= maxBytes) {
    return { value: new TextDecoder().decode(retained), truncated: false };
  }

  return { value: finishTruncated(retained, maxBytes), truncated: true };
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] ?? new Uint8Array(0);
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}

function finishTruncated(retained: Uint8Array, maxBytes: number): string {
  const budget = Math.max(0, maxBytes - SANDBOX_TRUNCATION_MARKER.length);
  // `stream: true` withholds a trailing incomplete UTF-8 sequence instead of
  // emitting a replacement character, keeping truncation UTF-8 safe.
  const head = new TextDecoder().decode(retained.subarray(0, budget), { stream: true });
  return head + SANDBOX_TRUNCATION_MARKER;
}
