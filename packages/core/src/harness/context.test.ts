import { expect, test } from "bun:test";
import { buildContext } from "./context";
import type { Profile } from "../profiles/profile";
import type { SessionRecord } from "../session/store";

const profile: Profile = {
  name: "test",
  mode: "interactive",
  systemPrompt: "system",
  skills: [],
  tools: [],
  sandboxPolicy: { kind: "local" },
  modelDefaults: {},
  policy: { toolError: "fail" }
};

test("buildContext bounds events and marks truncated context", () => {
  const session: SessionRecord = {
    id: "session-a",
    events: [
      event(0, { type: "message.user", content: "drop me" }),
      event(1, { type: "message.user", content: "keep me" }),
      event(2, {
        type: "tool.result",
        callId: "call",
        toolName: "read_file",
        result: { content: "x".repeat(100) }
      }),
      event(3, {
        type: "trigger.received",
        source: "github",
        kind: "pull_request",
        payload: { repo: "owner/repo" }
      })
    ]
  };
  const context = buildContext(session, profile, {
    maxEvents: 3,
    maxToolResultBytes: 20,
    maxTotalBytes: 200
  });

  expect(context.events.map((candidate) => candidate.offset)).toEqual([1, 2, 3]);
  expect(context.messages).toEqual([{ role: "user", content: "keep me" }]);
  expect(context.toolResults[0].content).toContain("[truncated]");
  expect(context.triggers[0]).toMatchObject({ source: "github", kind: "pull_request" });
  expect(context.truncated).toBe(true);
});

function event(offset: number, payload: Record<string, unknown>) {
  return {
    ...payload,
    id: `event-${offset}`,
    sessionId: "session-a",
    offset,
    createdAt: "2026-06-08T00:00:00.000Z"
  } as SessionRecord["events"][number];
}
