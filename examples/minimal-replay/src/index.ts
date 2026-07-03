import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import { defineProfile, defineTool, spawn, wake } from "@oma/core";

let toolExecutions = 0;

const store = new MemorySessionStore();
const profile = defineProfile({
  name: "minimal-replay",
  mode: "job",
  systemPrompt: "Prove tool results are recorded and replayed.",
  skills: [],
  tools: ["count"],
  sandboxPolicy: { kind: "local" },
  modelDefaults: {},
  policy: {}
});
const tools = [
  defineTool({
    name: "count",
    handler: async () => {
      toolExecutions += 1;
      return { toolExecutions };
    }
  })
];
const model = new FakeModelProvider([
  { toolCalls: [{ name: "count", args: {} }] },
  { finishReason: "done" }
]);
const sessionId = await spawn(store, profile, { initialMessage: "run once" });

await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });
await wake({ store, model, tools }, sessionId, profile, { maxSteps: 1 });

const session = await store.getSession(sessionId);

console.log(
  JSON.stringify(
    {
      toolExecutions,
      eventTypes: session.events.map((event) => event.type)
    },
    null,
    2
  )
);
