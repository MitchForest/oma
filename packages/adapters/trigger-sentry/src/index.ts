import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriggerSignal } from "@oma/core";

export interface SentryWebhookOptions {
  headers: Headers | Record<string, string | undefined>;
  body: string;
  /** The integration's client secret; verifies `sentry-hook-signature`. */
  secret?: string;
}

/**
 * Normalizes Sentry integration webhooks into trigger signals. Kind is
 * `<resource>.<action>` (`issue.created`, `event_alert.triggered`, …); the
 * payload surfaces the fields workflows filter and key sessions on, with the
 * raw payload preserved.
 */
export function normalizeSentryWebhook(options: SentryWebhookOptions): TriggerSignal {
  const resource = readHeader(options.headers, "sentry-hook-resource");

  if (!resource) {
    throw new Error("Missing Sentry-Hook-Resource header");
  }

  if (options.secret) {
    verifySignature(
      options.body,
      options.secret,
      readHeader(options.headers, "sentry-hook-signature")
    );
  }

  const payload = JSON.parse(options.body) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : "received";
  const data = isRecord(payload.data) ? payload.data : {};
  const issue = isRecord(data.issue) ? data.issue : undefined;
  const event = isRecord(data.event) ? data.event : undefined;
  const project = isRecord(issue?.project) ? issue.project : undefined;

  return {
    source: "sentry",
    kind: `${resource}.${action}`,
    payload: {
      issueId: readString(issue?.id) ?? readString(event?.issue_id),
      title: readString(issue?.title) ?? readString(event?.title),
      culprit: readString(issue?.culprit) ?? readString(event?.culprit),
      project: readString(project?.slug) ?? readString(event?.project_slug),
      permalink: readString(issue?.permalink) ?? readString(event?.web_url),
      action,
      raw: payload
    },
    deliveryId: readHeader(options.headers, "request-id"),
    receivedAt: new Date().toISOString(),
    metadata: {
      resource,
      action
    }
  };
}

export function sentrySignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function verifySignature(body: string, secret: string, signature: string | undefined): void {
  if (!signature) {
    throw new Error("Missing Sentry-Hook-Signature header");
  }

  const expected = sentrySignature(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid Sentry webhook signature");
  }
}

function readHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
