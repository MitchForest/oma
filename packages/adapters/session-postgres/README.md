# @oma/adapter-session-postgres

Postgres-backed OMA session store.

Use this adapter when multiple runtime processes need to read, append, and subscribe to the same durable event log.

```ts
import { PostgresSessionStore } from "@oma/adapter-session-postgres";

const store = new PostgresSessionStore({
  connectionString: process.env.DATABASE_URL!
});
```

The adapter implements the base `SessionStore`, store capabilities, and session projections. Subscriptions are cross-instance by querying the durable event log from the requested offset; notifications can be added later as a latency optimization without changing the correctness model.
