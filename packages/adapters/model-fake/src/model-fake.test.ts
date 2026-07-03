import { expect, test } from "bun:test";
import type { ModelInput, SessionEvent } from "@oma/core";
import { FakeModelProvider } from "./index";

test("FakeModelProvider replays turns indexed by recorded model.response count", async () => {
  const provider = new FakeModelProvider([
    { content: "turn one" },
    { toolCalls: [{ name: "read_file", args: { path: "README.md" } }] },
    { content: "turn three", finishReason: "done" }
  ]);

  expect(await provider.turn(modelInput([]))).toEqual({ content: "turn one" });

  expect(await provider.turn(modelInput([modelResponseEvent(0)]))).toEqual({
    toolCalls: [{ name: "read_file", args: { path: "README.md" } }]
  });

  expect(
    await provider.turn(modelInput([modelResponseEvent(0), modelResponseEvent(1)]))
  ).toEqual({ content: "turn three", finishReason: "done" });
});

test("FakeModelProvider ignores non-model.response events when indexing", async () => {
  const provider = new FakeModelProvider([{ content: "first" }, { content: "second" }]);

  const events: SessionEvent[] = [
    {
      id: "event-user",
      sessionId: "session-a",
      offset: 0,
      createdAt: "2026-06-08T00:00:00.000Z",
      type: "message.user",
      content: "hello"
    },
    modelResponseEvent(1),
    {
      id: "event-assistant",
      sessionId: "session-a",
      offset: 2,
      createdAt: "2026-06-08T00:00:00.000Z",
      type: "message.assistant",
      content: "first"
    }
  ];

  expect(await provider.turn(modelInput(events))).toEqual({ content: "second" });
});

test("FakeModelProvider stops with fake-turns-exhausted once turns run out", async () => {
  const provider = new FakeModelProvider([{ content: "only turn" }]);

  const exhausted = await provider.turn(modelInput([modelResponseEvent(0)]));

  expect(exhausted).toEqual({ finishReason: "fake-turns-exhausted" });
  expect(exhausted.content).toBeUndefined();
  expect(exhausted.toolCalls).toBeUndefined();

  // Stays exhausted on every later wake instead of repeating the last turn.
  expect(
    await provider.turn(modelInput([modelResponseEvent(0), modelResponseEvent(1)]))
  ).toEqual({ finishReason: "fake-turns-exhausted" });
});

test("FakeModelProvider with no configured turns is immediately exhausted", async () => {
  const provider = new FakeModelProvider([]);

  expect(await provider.turn(modelInput([]))).toEqual({
    finishReason: "fake-turns-exhausted"
  });
});

function modelResponseEvent(offset: number): SessionEvent {
  return {
    id: `event-model-${offset}`,
    sessionId: "session-a",
    offset,
    createdAt: "2026-06-08T00:00:00.000Z",
    type: "model.response",
    turn: {}
  };
}

function modelInput(events: SessionEvent[]): ModelInput {
  return {
    events,
    profile: {
      name: "test",
      mode: "interactive",
      systemPrompt: "system",
      skills: [],
      tools: [],
      sandboxPolicy: { kind: "local" },
      modelDefaults: {},
      policy: { toolError: "fail" }
    },
    context: {
      events: [],
      profile: {
        name: "test",
        mode: "interactive",
        systemPrompt: "system",
        skills: [],
        tools: []
      },
      messages: [],
      toolResults: [],
      triggers: [],
      truncated: false
    },
    tools: []
  };
}
