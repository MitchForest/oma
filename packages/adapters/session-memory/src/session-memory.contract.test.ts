import {
  runRunClaimContractTests,
  runSessionProjectionContractTests,
  runSessionStoreCapabilityContractTests,
  runSessionStoreContractTests
} from "@oma/core";
import { MemorySessionStore } from "./index";

runSessionStoreContractTests("MemorySessionStore", () => new MemorySessionStore());
runSessionStoreCapabilityContractTests("MemorySessionStore", () => new MemorySessionStore(), {
  durable: false,
  crossProcessSubscribe: false,
  efficientFork: true,
  listSessions: true,
  projections: true,
  runClaims: true
});
runSessionProjectionContractTests("MemorySessionStore", () => new MemorySessionStore());
runRunClaimContractTests("MemorySessionStore", () => new MemorySessionStore());
