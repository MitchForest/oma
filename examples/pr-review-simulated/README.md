# PR Review Simulated Example

Local proof of the PR review profile without GitHub or network access.

The example proves:

- one durable session per simulated PR via `sessionKey`
- second trigger wakes the same session
- prior comments are visible to the profile
- idempotent comment tools prevent duplicate side effects
- replay after a crash between external mutation and `tool.result` append is safe
- fork creates an independent second-opinion session
- repeated runs against the same `.oma/pr-review-simulated.sqlite` rehydrate comments from the durable event log instead of an in-memory cache

Run:

```bash
bun packages/cli/src/index.ts examples pr-review-simulated
bun packages/cli/src/index.ts examples pr-review-simulated --json
```
