import { createHmac, timingSafeEqual } from "node:crypto";
import type { TriggerSignal } from "@oma/core";

export interface GitHubWebhookOptions {
  headers: Headers | Record<string, string | undefined>;
  body: string;
  secret?: string;
}

export function normalizeGitHubWebhook(options: GitHubWebhookOptions): TriggerSignal {
  const event = readHeader(options.headers, "x-github-event");
  const delivery = readHeader(options.headers, "x-github-delivery");

  if (!event) {
    throw new Error("Missing X-GitHub-Event header");
  }

  if (options.secret) {
    verifySignature(options.body, options.secret, readHeader(options.headers, "x-hub-signature-256"));
  }

  const payload = JSON.parse(options.body) as Record<string, unknown>;
  const action = typeof payload.action === "string" ? payload.action : undefined;

  if (event === "pull_request" && action) {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    const repo = payload.repository as Record<string, unknown> | undefined;
    const fullName = typeof repo?.full_name === "string" ? repo.full_name : undefined;
    const number = typeof pr?.number === "number" ? pr.number : undefined;

    return {
      source: "github",
      kind: `pull_request.${action}`,
      payload: {
        repo: fullName,
        pr: number,
        action,
        head: readNestedString(pr, ["head", "sha"]),
        base: readNestedString(pr, ["base", "sha"]),
        // Surfaced so declarative workflow filters can skip drafts without
        // reaching into the raw provider payload.
        draft: typeof pr?.draft === "boolean" ? pr.draft : undefined,
        raw: payload
      },
      deliveryId: delivery,
      receivedAt: new Date().toISOString(),
      metadata: {
        event,
        action,
        repo: fullName,
        pr: number,
        sender: readNestedString(payload, ["sender", "login"])
      }
    };
  }

  return {
    source: "github",
    kind: event,
    payload,
    deliveryId: delivery,
    receivedAt: new Date().toISOString(),
    metadata: { event }
  };
}

export function githubSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function verifySignature(body: string, secret: string, signature: string | undefined): void {
  if (!signature) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }

  const expected = githubSignature(body, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid GitHub webhook signature");
  }
}

function readHeader(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  const result = path.reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, value);

  return typeof result === "string" ? result : undefined;
}
