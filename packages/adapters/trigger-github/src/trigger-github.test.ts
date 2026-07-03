import { expect, test } from "bun:test";
import { githubSignature, normalizeGitHubWebhook } from "./index";

test("normalizeGitHubWebhook verifies signatures and maps pull request events", () => {
  const body = JSON.stringify({
    action: "synchronize",
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 42,
      head: { sha: "head-sha" },
      base: { sha: "base-sha" }
    },
    sender: { login: "octocat" }
  });
  const signal = normalizeGitHubWebhook({
    body,
    secret: "secret",
    headers: {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": githubSignature(body, "secret")
    }
  });

  expect(signal).toMatchObject({
    source: "github",
    kind: "pull_request.synchronize",
    deliveryId: "delivery-1",
    payload: {
      repo: "owner/repo",
      pr: 42,
      head: "head-sha",
      base: "base-sha"
    },
    metadata: {
      event: "pull_request",
      action: "synchronize",
      sender: "octocat"
    }
  });

  expect(() =>
    normalizeGitHubWebhook({
      body,
      secret: "secret",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=bad"
      }
    })
  ).toThrow("Invalid GitHub webhook signature");
});
