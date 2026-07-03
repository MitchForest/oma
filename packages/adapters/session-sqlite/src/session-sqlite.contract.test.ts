import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  createTimestamp,
  runRunClaimContractTests,
  runSessionProjectionContractTests,
  runSessionStoreCapabilityContractTests,
  runSessionStoreContractTests
} from "@oma/core";
import { SqliteSessionStore } from "./index";

function makeStore(): SqliteSessionStore {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-store-"));
  return new SqliteSessionStore(join(dir, "sessions.sqlite"));
}

runSessionStoreContractTests("SqliteSessionStore", makeStore);
runSessionStoreCapabilityContractTests("SqliteSessionStore", makeStore, {
  durable: true,
  crossProcessSubscribe: false,
  efficientFork: false,
  listSessions: true,
  projections: true,
  runClaims: true
});
runSessionProjectionContractTests("SqliteSessionStore", makeStore);
runRunClaimContractTests("SqliteSessionStore", makeStore);

test("SqliteSessionStore: records schema version", () => {
  const store = makeStore();

  expect(store.schemaVersion()).toBe(3);
});

test("SqliteSessionStore: refuses databases with a newer schema version", () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-newer-"));
  const path = join(dir, "sessions.sqlite");
  const db = new Database(path, { create: true });

  db.exec(`
    create table oma_schema_version (
      version integer primary key,
      applied_at text not null
    );
  `);
  db.query("insert into oma_schema_version (version, applied_at) values (?, ?)").run(
    99,
    createTimestamp()
  );
  db.close();

  expect(() => new SqliteSessionStore(path)).toThrow("Unsupported SQLite store schema version");
});

test("SqliteSessionStore: migrates a v1 database (legacy offset column) to v2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-migrate-"));
  const path = join(dir, "sessions.sqlite");
  const db = new Database(path, { create: true });
  const createdAt = createTimestamp();

  // Reproduce the v1 schema exactly as the v1 store created it.
  db.exec(`
    create table sessions (
      id text primary key,
      metadata_json text,
      created_at text not null
    );

    create table events (
      session_id text not null references sessions(id) on delete cascade,
      offset integer not null,
      id text not null,
      created_at text not null,
      type text not null,
      payload_json text not null,
      primary key (session_id, offset),
      unique (id)
    );

    create table event_idempotency (
      session_id text not null references sessions(id) on delete cascade,
      idempotency_key text not null,
      offset integer not null,
      primary key (session_id, idempotency_key)
    );

    create table oma_schema_version (
      version integer primary key,
      applied_at text not null
    );
  `);
  db.query("insert into oma_schema_version (version, applied_at) values (1, ?)").run(createdAt);
  db.query("insert into sessions (id, metadata_json, created_at) values (?, ?, ?)").run(
    "legacy",
    JSON.stringify({ profilePath: "profile.json" }),
    createdAt
  );
  db.query(
    `insert into events (session_id, offset, id, created_at, type, payload_json)
     values (?, ?, ?, ?, ?, ?)`
  ).run(
    "legacy",
    0,
    "event-0",
    createdAt,
    "system.note",
    JSON.stringify({ type: "system.note", message: "zero" })
  );
  db.query(
    `insert into events (session_id, offset, id, created_at, type, payload_json)
     values (?, ?, ?, ?, ?, ?)`
  ).run(
    "legacy",
    1,
    "event-1",
    createdAt,
    "system.note",
    JSON.stringify({ type: "system.note", message: "one" })
  );
  db.query(
    "insert into event_idempotency (session_id, idempotency_key, offset) values (?, ?, ?)"
  ).run("legacy", "note:one", 1);
  db.close();

  const store = new SqliteSessionStore(path);

  expect(store.schemaVersion()).toBe(3);

  const session = await store.getSession("legacy");

  expect(session.metadata).toEqual({ profilePath: "profile.json" });
  expect(session.events.map((event) => event.offset)).toEqual([0, 1]);
  expect(session.events[0]).toMatchObject({ type: "system.note", message: "zero" });

  const appended = await store.appendEvent("legacy", {
    type: "system.note",
    message: "post-migration"
  });

  expect(appended.offset).toBe(2);

  const idempotent = await store.appendEvent(
    "legacy",
    { type: "system.note", message: "duplicate" },
    { idempotencyKey: "note:one" }
  );

  expect(idempotent.id).toBe("event-1");
  expect(idempotent.offset).toBe(1);

  // Reopening the migrated database must be a no-op.
  store.close();

  const reopened = new SqliteSessionStore(path);

  expect(reopened.schemaVersion()).toBe(3);
  expect((await reopened.getSession("legacy")).events).toHaveLength(3);
  reopened.close();
});

test("SqliteSessionStore: persists sessions across store instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-persist-"));
  const path = join(dir, "sessions.sqlite");
  const first = new SqliteSessionStore(path);
  const sessionId = await first.createSession({ id: "persisted" });

  await first.appendEvent(sessionId, { type: "system.note", message: "saved" });
  first.close();

  const second = new SqliteSessionStore(path);
  const session = await second.getSession(sessionId);

  expect(session.events).toHaveLength(1);
  expect(session.events[0]).toMatchObject({ type: "system.note", message: "saved" });
});

test("SqliteSessionStore: expectedOffset rejects stale multi-instance writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-concurrency-"));
  const path = join(dir, "sessions.sqlite");
  const first = new SqliteSessionStore(path);
  const second = new SqliteSessionStore(path);

  await first.createSession({ id: "session-a" });

  const results = await Promise.allSettled([
    first.appendEvent(
      "session-a",
      { type: "system.note", message: "one" },
      { expectedOffset: 0 }
    ),
    second.appendEvent(
      "session-a",
      { type: "system.note", message: "two" },
      { expectedOffset: 0 }
    )
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((await first.getSession("session-a")).events).toHaveLength(1);
});

test("SqliteSessionStore: idempotency works across store instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-idempotency-"));
  const path = join(dir, "sessions.sqlite");
  const first = new SqliteSessionStore(path);
  const second = new SqliteSessionStore(path);

  await first.createSession({ id: "session-a" });

  const [left, right] = await Promise.all([
    first.appendEvent(
      "session-a",
      { type: "system.note", message: "one" },
      { idempotencyKey: "same" }
    ),
    second.appendEvent(
      "session-a",
      { type: "system.note", message: "two" },
      { idempotencyKey: "same" }
    )
  ]);

  expect(left.id).toBe(right.id);
  expect(left.offset).toBe(right.offset);
  expect((await first.getSession("session-a")).events).toHaveLength(1);
});

test("SqliteSessionStore: fork stays independent while original continues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oma-sqlite-fork-"));
  const path = join(dir, "sessions.sqlite");
  const store = new SqliteSessionStore(path);

  await store.createSession({ id: "session-a", metadata: { profilePath: "profile.json" } });
  await store.appendEvent("session-a", { type: "system.note", message: "zero" });
  await store.appendEvent("session-a", { type: "system.note", message: "one" });

  const forkId = await store.fork("session-a", 0, { id: "session-b" });

  await store.appendEvent("session-a", { type: "system.note", message: "original" });
  await store.appendEvent(forkId, { type: "system.note", message: "fork" });

  expect((await store.getSession("session-a")).events.map((event) => event.offset)).toEqual([
    0, 1, 2
  ]);
  expect((await store.getSession(forkId)).events.map((event) => event.offset)).toEqual([
    0, 1, 2
  ]);
  expect((await store.getSession(forkId)).metadata).toEqual({ profilePath: "profile.json" });
});
