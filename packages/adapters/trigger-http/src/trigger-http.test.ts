import { expect, test } from "bun:test";
import { createHttpTriggerServer } from "./index";

test("HTTP trigger server normalizes webhook posts", async () => {
  const received: unknown[] = [];
  const server = await createHttpTriggerServer({
    secret: "secret",
    dispatch: async (signal) => {
      received.push(signal);
      return { type: "spawned", sessionId: "session-1" };
    }
  });

  try {
    const unauthorized = await fetch(`${server.url}/webhooks/github/pull_request.opened`, {
      method: "POST",
      body: "{}"
    });
    const response = await fetch(`${server.url}/webhooks/github/pull_request.opened`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oma-secret": "secret",
        "x-oma-delivery": "delivery-1"
      },
      body: JSON.stringify({ repo: "owner/repo", pr: 42 })
    });
    const body = await response.json();

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(body.signal).toMatchObject({
      source: "github",
      kind: "pull_request.opened",
      deliveryId: "delivery-1",
      payload: { repo: "owner/repo", pr: 42 }
    });
  } finally {
    await server.close();
  }
});


test("source handlers normalize raw bodies and own their authentication", async () => {
  const received: unknown[] = [];
  const server = await createHttpTriggerServer({
    sources: {
      github: {
        normalize: ({ headers, body, kind }) => {
          if (headers.get("x-hub-signature-256") !== "sha256=valid") {
            throw new Error("Invalid GitHub webhook signature");
          }

          const payload = JSON.parse(body) as { pr: number };
          return {
            source: "github",
            kind: kind ?? "pull_request.opened",
            payload,
            deliveryId: headers.get("x-github-delivery") ?? undefined
          };
        }
      }
    },
    dispatch: async (signal) => {
      received.push(signal);
      return { type: "spawned", sessionId: "session-1" };
    }
  });

  try {
    const rejected = await fetch(`${server.url}/webhooks/github`, {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=bogus" },
      body: JSON.stringify({ pr: 42 })
    });

    expect(rejected.status).toBe(400);
    expect(received).toHaveLength(0);

    const accepted = await fetch(`${server.url}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-hub-signature-256": "sha256=valid",
        "x-github-delivery": "delivery-9"
      },
      body: JSON.stringify({ pr: 42 })
    });
    const body = await accepted.json();

    expect(accepted.status).toBe(200);
    expect(received).toHaveLength(1);
    // The handler response echoes routing identity only, never the payload.
    expect(body.signal).toEqual({
      source: "github",
      kind: "pull_request.opened",
      deliveryId: "delivery-9"
    });

    const generic = await fetch(`${server.url}/webhooks/stripe/invoice.paid`, {
      method: "POST",
      body: JSON.stringify({ id: "in_1" })
    });

    expect(generic.status).toBe(200);
    expect(received).toHaveLength(2);
  } finally {
    await server.close();
  }
});
