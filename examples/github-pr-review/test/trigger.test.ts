import { describe, expect, test } from "bun:test";
import { parseTriggerComment, reviewRequestFromFixture } from "../src/trigger";

describe("trigger parsing", () => {
  test("accepts OMA trigger with verbose flag", () => {
    expect(parseTriggerComment("oma review verbose=true")).toEqual({
      ok: true,
      command: "oma review verbose=true",
      verbose: true,
    });
  });

  test("accepts compatibility triggers", () => {
    expect(parseTriggerComment("bugbot run")).toMatchObject({ ok: true });
    expect(parseTriggerComment("cursor review")).toMatchObject({ ok: true });
  });

  test("ignores unrelated comments", () => {
    expect(parseTriggerComment("please review")).toEqual({
      ok: false,
      reason: "Comment does not contain an OMA review trigger.",
    });
  });

  test("loads fixture request", async () => {
    const request = await reviewRequestFromFixture("examples/github-pr-review/fixtures/basic");
    expect(request.repository.fullName).toBe("oma/example");
    expect(request.pullRequest.number).toBe(42);
    expect(request.trigger.verbose).toBe(true);
  });
});
