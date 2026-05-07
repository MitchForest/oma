import type { StoredEvent } from "@oma/runtime";

export type EventBus = {
  publish(runId: string, event: StoredEvent | { type: "oma.done"; data: unknown }): void;
  subscribe(runId: string): AsyncIterable<StoredEvent | { type: "oma.done"; data: unknown }>;
};

export function createEventBus(): EventBus {
  const subscribers = new Map<
    string,
    Set<(event: StoredEvent | { type: "oma.done"; data: unknown }) => void>
  >();

  return {
    publish(runId, event) {
      for (const subscriber of subscribers.get(runId) ?? []) {
        subscriber(event);
      }
    },

    subscribe(runId) {
      return {
        [Symbol.asyncIterator]() {
          const queue: Array<StoredEvent | { type: "oma.done"; data: unknown }> = [];
          let wake: (() => void) | undefined;

          const push = (event: StoredEvent | { type: "oma.done"; data: unknown }) => {
            queue.push(event);
            wake?.();
            wake = undefined;
          };

          const set = subscribers.get(runId) ?? new Set();
          set.add(push);
          subscribers.set(runId, set);

          return {
            async next() {
              if (queue.length === 0) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }

              const value = queue.shift();
              return {
                done: false,
                value: value as StoredEvent | { type: "oma.done"; data: unknown },
              };
            },

            async return() {
              set.delete(push);
              return {
                done: true,
                value: undefined,
              };
            },
          };
        },
      };
    },
  };
}

export function sseStream(input: {
  existing: StoredEvent[];
  follow: AsyncIterable<StoredEvent | { type: "oma.done"; data: unknown }>;
}): Response {
  const encoder = new TextEncoder();

  function encode(event: string, value: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of input.existing) {
        controller.enqueue(encode("oma.event", event));
      }

      for await (const event of input.follow) {
        if ("type" in event && event.type === "oma.done") {
          controller.enqueue(encode("oma.done", event.data));
          break;
        }
        controller.enqueue(encode("oma.event", event));
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}
