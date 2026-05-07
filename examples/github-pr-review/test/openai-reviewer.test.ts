import { describe, expect, test } from "bun:test";
import { openAIReadOnlyReviewHarness } from "../src/openai-reviewer";
import type { Event, Session } from "@oma/runtime";
import type { PullRequestContext } from "../src/types";

const context: PullRequestContext = {
  request: {
    repository: {
      owner: "oma",
      name: "example",
      fullName: "oma/example",
    },
    pullRequest: {
      number: 1,
      baseSha: "base",
      headSha: "head",
    },
    trigger: {
      source: "fixture",
      command: "oma review",
      verbose: false,
    },
  },
  title: "Example PR",
  body: "",
  author: "mitch",
  baseBranch: "main",
  headBranch: "branch",
  files: [
    {
      filename: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
    },
  ],
  diff: [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1,2 @@",
    "+dangerousCall();",
  ].join("\n"),
  existingFindingIds: [],
};

describe("OpenAI read-only reviewer harness", () => {
  test("uses read-only tools and returns review artifacts", async () => {
    const readPaths: string[] = [];
    const requestBodies: unknown[] = [];
    let requestCount = 0;
    const harness = openAIReadOnlyReviewHarness({
      apiKey: "test-key",
      context,
      fetch: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body)) as unknown);
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({
              output: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "read_file",
                  arguments: JSON.stringify({ path: "src/app.ts" }),
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              schemaVersion: 1,
              summary: "No high-signal findings.",
              findings: [],
            }),
          }),
        );
      },
    });

    const result = await harness.run({
      runId: "run_test",
      objective: {
        goal: "review",
        constraints: [],
        success: [],
      },
      session: {
        id: "session_test",
        append: async (event) =>
          ({
            ...event,
            id: "event_test",
            schemaVersion: 1,
            sequence: 1,
            sessionId: "session_test",
          }) as Event,
        events: async () => [],
      } as Session,
      observe: async (event) => ({
        id: "event_observed",
        schemaVersion: 1,
        sequence: 1,
        sessionId: "session_test",
        runId: "run_test",
        type: "harness.observed",
        at: new Date().toISOString(),
        data: {
          harnessId: "openai-readonly-review",
          ...event,
        },
      }),
      environment: {
        kind: "test",
        capabilities: {
          filesystem: true,
          git: true,
          securityBoundary: false,
          shell: true,
        },
        filesystem: {
          list: async () => [],
          readText: async (path) => {
            readPaths.push(path);
            return "export function app() { dangerousCall(); }";
          },
          writeText: async () => {
            throw new Error("writeText should not be exposed through reviewer tools.");
          },
        },
        git: {
          diff: async () => context.diff,
          status: async () => ({
            clean: false,
            short: "M src/app.ts",
          }),
        },
        shell: {
          exec: async () => ({
            command: "rg",
            args: [],
            cwd: ".",
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdout: "",
            stderr: "",
            truncated: {
              stdout: false,
              stderr: false,
            },
          }),
        },
      },
    });

    expect(readPaths).toEqual(["src/app.ts"]);
    expect(requestBodies[0]).toMatchObject({
      model: "gpt-5.5",
      reasoning: {
        effort: "medium",
      },
    });
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      ".oma/pr-review-summary.md",
      ".oma/pr-review-findings.json",
      ".oma/pr-review-findings.md",
    ]);
  });
});
