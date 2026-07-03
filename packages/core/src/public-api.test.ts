import { expect, test } from "bun:test";
import * as core from "@oma/core";

test("@oma/core exposes the local alpha public surface", () => {
  for (const name of [
    "appendEvent",
    "buildContext",
    "defineProfile",
    "defineTool",
    "defineTrigger",
    "deriveSessionView",
    "eventPayloadSchema",
    "fork",
    "getSession",
    "hasSessionProjections",
    "indexTools",
    "MemoryWakeLock",
    "routeTriggerSignal",
    "runSandboxProviderContractTests",
    "runSessionStoreContractTests",
    "send",
    "sessionEventSchema",
    "spawn",
    "step",
    "toJsonValue",
    "wake"
  ]) {
    expect(core).toHaveProperty(name);
  }
});
