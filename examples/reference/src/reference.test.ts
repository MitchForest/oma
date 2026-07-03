import { expect, test } from "bun:test";
import {
  referenceExamples,
  runReferenceExample,
  type ExampleName,
  type ExampleResult
} from "./index";

test("reference example catalog exposes deterministic examples", () => {
  expect(referenceExamples).toEqual([
    expect.objectContaining({ name: "minimal-replay", requiresNetwork: false }),
    expect.objectContaining({ name: "pr-review-simulated", requiresNetwork: false }),
    expect.objectContaining({ name: "local-coding-agent", requiresNetwork: false }),
    expect.objectContaining({ name: "background-job", requiresNetwork: false }),
    expect.objectContaining({ name: "forked-approaches", requiresNetwork: false }),
    expect.objectContaining({ name: "multiplayer-viewer", requiresNetwork: false }),
    expect.objectContaining({ name: "mcp-import", requiresNetwork: false }),
    expect.objectContaining({ name: "github-pr-review-webhook", requiresNetwork: false })
  ]);
});

test("reference examples prove their named claims", async () => {
  const results = new Map<ExampleName, ExampleResult>();

  for (const example of referenceExamples) {
    results.set(example.name, await runReferenceExample(example.name));
  }

  for (const example of referenceExamples) {
    expect(results.get(example.name)).toMatchObject({
      example: example.name,
      claim: example.claim,
      status: "passed"
    });
  }

  expect(results.get("minimal-replay")).toMatchObject({
    toolExecutions: 1,
    toolResultEvents: 1,
    wakeStatus: "completed"
  });
  expect(results.get("pr-review-simulated")).toMatchObject({
    sessionId: "review:owner/repo#42",
    wakeCount: 2,
    duplicateComments: 0
  });
  expect(results.get("local-coding-agent")).toMatchObject({
    wakeStatus: "completed",
    toolCalls: ["list_files", "bash"],
    sandboxEvents: expect.arrayContaining(["sandbox.provisioned", "sandbox.exec.completed"])
  });
  expect(results.get("background-job")).toMatchObject({
    wakeStatus: "completed",
    runEvents: expect.arrayContaining(["run.started", "run.completed"])
  });
  expect(results.get("forked-approaches")).toMatchObject({
    diverged: true,
    forks: [
      expect.objectContaining({ wakeStatus: "completed" }),
      expect.objectContaining({ wakeStatus: "completed" })
    ]
  });
  expect(results.get("multiplayer-viewer")).toMatchObject({
    subscribersMatched: true,
    subscriberEventTypes: [
      ["session.started", "message.user", "message.assistant", "system.note"],
      ["session.started", "message.user", "message.assistant", "system.note"]
    ]
  });
  expect(JSON.stringify(results.get("mcp-import"))).toContain("hello:missing:visible");
  expect(results.get("github-pr-review-webhook")).toMatchObject({
    route: { type: "spawned", sessionId: "review:owner/repo#42" },
    normalized: {
      source: "github",
      kind: "pull_request.synchronize",
      repo: "owner/repo",
      pr: 42
    }
  });
});
