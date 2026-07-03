import { expect, test } from "bun:test";
import { normalizeSentryWebhook, sentrySignature } from "./index";

const issuePayload = JSON.stringify({
  action: "created",
  data: {
    issue: {
      id: "12345",
      title: "TypeError: cannot read properties of undefined",
      culprit: "app/auth.ts in login",
      permalink: "https://sentry.io/organizations/acme/issues/12345/",
      project: { slug: "web", id: 7 }
    }
  },
  actor: { type: "application", id: "sentry" }
});

test("normalizes issue webhooks with verified signatures", () => {
  const signal = normalizeSentryWebhook({
    headers: {
      "sentry-hook-resource": "issue",
      "sentry-hook-signature": sentrySignature(issuePayload, "shh"),
      "request-id": "req-1"
    },
    body: issuePayload,
    secret: "shh"
  });

  expect(signal).toMatchObject({
    source: "sentry",
    kind: "issue.created",
    deliveryId: "req-1",
    payload: {
      issueId: "12345",
      title: "TypeError: cannot read properties of undefined",
      culprit: "app/auth.ts in login",
      project: "web",
      permalink: "https://sentry.io/organizations/acme/issues/12345/"
    }
  });
  expect((signal.payload as { raw: unknown }).raw).toBeDefined();

  expect(() =>
    normalizeSentryWebhook({
      headers: {
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": "bogus"
      },
      body: issuePayload,
      secret: "shh"
    })
  ).toThrow("Invalid Sentry webhook signature");

  expect(() =>
    normalizeSentryWebhook({ headers: {}, body: issuePayload })
  ).toThrow("Missing Sentry-Hook-Resource");
});

test("normalizes event alerts via the event shape", () => {
  const alertPayload = JSON.stringify({
    action: "triggered",
    data: {
      event: {
        issue_id: "999",
        title: "Payment webhook 500s",
        culprit: "billing/webhooks.ts",
        project_slug: "api",
        web_url: "https://sentry.io/x"
      },
      triggered_rule: "High volume errors"
    }
  });

  const signal = normalizeSentryWebhook({
    headers: { "sentry-hook-resource": "event_alert" },
    body: alertPayload
  });

  expect(signal.kind).toBe("event_alert.triggered");
  expect(signal.payload).toMatchObject({
    issueId: "999",
    title: "Payment webhook 500s",
    project: "api"
  });
});
