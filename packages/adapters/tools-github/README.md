# @oma/adapter-tools-github

GitHub pull request tools for OMA profiles.

```ts
import { createGitHubTools } from "@oma/adapter-tools-github";

const tools = createGitHubTools({
  token: process.env.GITHUB_TOKEN!
});
```

Options:

- `baseUrl` — REST API base (default `https://api.github.com`).
- `graphqlUrl` — GraphQL endpoint used by `resolve_thread` (default `${baseUrl}/graphql`;
  override for GitHub Enterprise, where REST and GraphQL bases differ).
- `maxLogBytes` — byte cap for `get_ci_logs` output (default 64 KiB); results carry a
  `truncated` flag.

Safety and replay behavior:

- All `repo`, id, ref, and file-path arguments are validated (no path separators or
  `..` traversal) and request paths are built from URI-encoded segments, so a
  prompt-injected model cannot redirect a write to an arbitrary API path.
- Mutation tools return provider ids and urls, and define stable idempotency keys so
  replay can recover safely around external side effects. Posted bodies carry a
  `sha256` marker of the idempotency key (the human-readable key is only recorded in
  tool-result metadata); crash recovery scans listing pages (per_page=100, following
  `Link: rel="next"`, capped at 10 pages) and fails closed — it throws rather than
  reposting if the cap is reached before the listing is exhausted.
- `resolve_thread` issues the GraphQL `resolveReviewThread` mutation (the `threadId`
  is the review-thread node id) and throws on GraphQL errors.
- `get_ci_logs` fetches plain-text logs for a single workflow job
  (`/actions/jobs/{jobId}/logs`) rather than the zip archive of a whole run.
