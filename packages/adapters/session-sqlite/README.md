# @oma/adapter-session-sqlite

SQLite-backed `SessionStore` for local OMA runtimes.

It provides durable sessions, contiguous offsets, optimistic `expectedOffset` writes, append idempotency keys, session forks, and historical replay.

Live `subscribe` is process-local: it replays durable history from SQLite and streams future events appended through the same store instance. It does not provide cross-process live streams.

```ts
import { SqliteSessionStore } from "@oma/adapter-session-sqlite";

const store = new SqliteSessionStore(".oma/sessions.sqlite");
```
