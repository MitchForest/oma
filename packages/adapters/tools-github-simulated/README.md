# @oma/adapter-tools-github-simulated

Simulated GitHub PR review tools for local OMA examples and profile fixtures.

The write tools are idempotent by stable review/comment keys and return provider-like
ids so replay behavior matches the real GitHub adapter shape:

- `post_review` accepts an optional `event` (`COMMENT` default, `REQUEST_CHANGES`,
  `APPROVE`) and includes it in the idempotency key, matching the real adapter.
- `reply_to_comment` takes `repo`/`pr`/`commentId` (matching the real adapter) and
  assigns a unique provider id per distinct reply while replaying the same reply
  idempotently.
- `hydrateSimulatedGitHubStateFromLog` rebuilds comments, reviews, and replies from a
  session log; absent `reviews`/`replies` maps are created on the passed state so
  hydration and the tools always share the same maps.
