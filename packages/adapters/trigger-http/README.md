# @oma/adapter-trigger-http

Generic Bun HTTP webhook receiver for OMA trigger signals.

It accepts `POST /webhooks/:source/:kind`, parses the JSON body as `payload`, adds safe request metadata, and calls a supplied dispatch function. The adapter does not load profiles or make agent decisions.

```ts
import { createHttpTriggerServer } from "@oma/adapter-trigger-http";

const server = await createHttpTriggerServer({
  port: 8787,
  secret: process.env.OMA_WEBHOOK_SECRET,
  dispatch: async (signal) => route(signal)
});
```

Use the `x-oma-secret` header when `secret` is configured.
