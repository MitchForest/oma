# @oma/adapter-trigger-github

GitHub webhook normalizer for OMA trigger signals.

The adapter verifies `X-Hub-Signature-256` when a secret is provided, reads GitHub delivery metadata, and normalizes pull request webhooks into PR Review-compatible signals such as `github:pull_request.synchronize`.

It does not call GitHub APIs and does not post comments. GitHub reads and writes belong in tool adapters.

```ts
const signal = normalizeGitHubWebhook({
  body,
  secret: process.env.GITHUB_WEBHOOK_SECRET,
  headers: request.headers
});
```
