import { expect, test } from "bun:test";
import {
  runCrossProcessSubscribeContractTest,
  runRunClaimContractTests,
  runSessionProjectionContractTests,
  runSessionStoreCapabilityContractTests,
  runSessionStoreContractTests
} from "@oma/core";
import { PostgresSessionStore } from "./index";

const databaseUrl = process.env.DATABASE_URL;

function makeStore(): PostgresSessionStore {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Postgres store tests");
  }

  const store = new PostgresSessionStore({
    connectionString: databaseUrl,
    pollMs: 25
  });

  return store;
}

if (databaseUrl) {
  runSessionStoreContractTests("PostgresSessionStore", makeStore);
  runSessionStoreCapabilityContractTests("PostgresSessionStore", makeStore, {
    durable: true,
    crossProcessSubscribe: true,
    efficientFork: false,
    listSessions: true,
    projections: true,
    runClaims: true
  });
  runSessionProjectionContractTests("PostgresSessionStore", makeStore);
  runRunClaimContractTests("PostgresSessionStore", makeStore);
  runCrossProcessSubscribeContractTest("PostgresSessionStore", () => {
    const subscriber = makeStore();
    const appender = new PostgresSessionStore({
      connectionString: databaseUrl,
      pollMs: 25
    });

    return { subscriber, appender };
  });
  test("PostgresSessionStore: records schema version", async () => {
    const store = makeStore();

    expect(await store.schemaVersion()).toBe(3);
  });
}

if (!databaseUrl) {
  test("PostgresSessionStore: skips integration tests without DATABASE_URL", () => {
    expect(databaseUrl).toBeUndefined();
  });
}
