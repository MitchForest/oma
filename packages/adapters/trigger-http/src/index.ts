import type { TriggerRouteResult, TriggerSignal } from "@oma/core";

export interface HttpTriggerSourceHandler {
  /**
   * Builds a TriggerSignal from the raw request (headers + body text), so
   * providers with signed payloads (GitHub HMAC) can verify before parsing.
   * Throwing rejects the delivery with a 400.
   */
  normalize(input: { headers: Headers; body: string; kind?: string }): TriggerSignal;
}

export interface HttpTriggerServerOptions {
  port?: number;
  hostname?: string;
  secret?: string;
  secretHeader?: string;
  /**
   * Source-specific normalizers keyed by source name. A POST to
   * `/webhooks/<source>` (kind optional) routes through the handler instead of
   * the generic JSON path; the handler owns its own authentication.
   */
  sources?: Record<string, HttpTriggerSourceHandler>;
  dispatch(signal: TriggerSignal): Promise<TriggerRouteResult | unknown>;
}

export interface HttpTriggerServer {
  url: string;
  close(): Promise<void>;
}

export async function createHttpTriggerServer(
  options: HttpTriggerServerOptions
): Promise<HttpTriggerServer> {
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    async fetch(request) {
      const url = new URL(request.url);
      const match = /^\/webhooks\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);

      if (request.method !== "POST" || !match) {
        return json({ error: "not_found" }, 404);
      }

      const source = decodeURIComponent(match[1]!);
      const kindPart = match[2] ? decodeURIComponent(match[2]) : undefined;
      const handler = options.sources?.[source];

      if (handler) {
        const body = await request.text();
        let signal: TriggerSignal;

        try {
          signal = handler.normalize({ headers: request.headers, body, kind: kindPart });
        } catch (error) {
          return json(
            {
              error: "rejected",
              message: error instanceof Error ? error.message : String(error)
            },
            400
          );
        }

        const result = await options.dispatch(signal);

        // Echo only the routing identity, not the payload: provider payloads
        // (a full GitHub PR object) do not belong in webhook responses.
        return json({
          signal: { source: signal.source, kind: signal.kind, deliveryId: signal.deliveryId },
          result
        });
      }

      if (!kindPart) {
        return json({ error: "not_found" }, 404);
      }

      if (options.secret) {
        const header = options.secretHeader ?? "x-oma-secret";

        if (request.headers.get(header) !== options.secret) {
          return json({ error: "unauthorized" }, 401);
        }
      }

      let payload: unknown;

      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid_json" }, 400);
      }

      const signal: TriggerSignal = {
        source,
        kind: kindPart,
        payload,
        deliveryId: request.headers.get("x-oma-delivery") ?? undefined,
        receivedAt: new Date().toISOString(),
        metadata: {
          method: request.method,
          pathname: url.pathname,
          userAgent: request.headers.get("user-agent") ?? undefined
        }
      };
      const result = await options.dispatch(signal);

      return json({ signal, result });
    }
  });

  return {
    url: `http://${server.hostname}:${server.port}`,
    close: async () => server.stop(true)
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}
