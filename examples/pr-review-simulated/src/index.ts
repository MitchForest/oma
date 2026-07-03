import { FakeModelProvider } from "@oma/adapter-model-fake";
import { MemorySessionStore } from "@oma/adapter-session-memory";
import {
  createSimulatedGitHubTools,
  hydrateSimulatedGitHubStateFromLog,
  type SimulatedComment,
  type SimulatedGitHubState
} from "@oma/adapter-tools-github-simulated";
import {
  MemoryWakeLock,
  defineProfile,
  routeTriggerSignal,
  type AnyTool,
  type HarnessRuntime,
  type SessionStore,
  type Profile
} from "@oma/core";

export type { SimulatedComment } from "@oma/adapter-tools-github-simulated";

export interface RunPrReviewSimulationOptions {
  store: SessionStore;
}

export async function runPrReviewSimulation(options: RunPrReviewSimulationOptions): Promise<{
  sessionId: string;
  forkId: string;
  comments: SimulatedComment[];
}> {
  const sessionId = "review:owner/repo#42";
  // One shared state object so hydrated comments, reviews, and replies all
  // reach the tools that replay against them.
  const state: SimulatedGitHubState = { comments: new Map<string, SimulatedComment>() };
  const { store } = options;
  const profile = simulatedPrReviewProfile();

  await hydrateSimulatedGitHubStateFromLog(store, sessionId, state);

  const tools = createSimulatedGitHubTools(state);
  const runtime: HarnessRuntime = {
    store,
    tools,
    model: createPrReviewModelProvider(),
    wakeLock: new MemoryWakeLock()
  };
  const trigger = {
    on: "simulated-github:pull_request.*",
    profile,
    prompt: (signal: { payload: unknown }) =>
      `Review PR ${(signal.payload as { repo: string; pr: number }).repo}#${(signal.payload as { pr: number }).pr}.`
  };
  const opened = {
    source: "simulated-github",
    kind: "pull_request.opened",
    payload: { repo: "owner/repo", pr: 42, head: "abc123" }
  };
  const synchronized = {
    source: "simulated-github",
    kind: "pull_request.synchronize",
    payload: { repo: "owner/repo", pr: 42, head: "def456" }
  };
  const first = await routeTriggerSignal(runtime, trigger, opened);
  const second = await routeTriggerSignal(runtime, trigger, synchronized);
  const routedSessionId = first.type === "spawned" || first.type === "woken" ? first.sessionId : sessionId;
  const session = await store.getSession(
    second.type === "spawned" || second.type === "woken" ? second.sessionId : routedSessionId
  );
  const forkId = await store.fork(session.id, Math.min(3, session.events.length - 1), {
    metadata: session.metadata
  });

  return {
    sessionId: session.id,
    forkId,
    comments: [...state.comments.values()]
  };
}

export async function hydrateCommentsFromLog(
  store: SessionStore,
  sessionId: string,
  comments: Map<string, SimulatedComment>
): Promise<void> {
  await hydrateSimulatedGitHubStateFromLog(store, sessionId, { comments });
}

export function createPrReviewModelProvider(): FakeModelProvider {
  return new FakeModelProvider([
    { toolCalls: [{ name: "get_pr_metadata", args: { repo: "owner/repo", pr: 42 } }] },
    { toolCalls: [{ name: "get_diff", args: { repo: "owner/repo", pr: 42 } }] },
    {
      toolCalls: [
        {
          name: "post_inline_comment",
          args: {
            key: "owner/repo#42:src/app.ts:12:missing-test",
            path: "src/app.ts",
            line: 12,
            body: "The new branch returns false without a test covering the changed behavior."
          }
        }
      ]
    },
    {
      toolCalls: [
        {
          name: "post_review",
          args: {
            repo: "owner/repo",
            pr: 42,
            body: "Found one actionable issue in the simulated diff."
          }
        }
      ]
    },
    { finishReason: "done" },
    { toolCalls: [{ name: "get_prior_comments", args: { repo: "owner/repo", pr: 42 } }] },
    {
      toolCalls: [
        {
          name: "post_inline_comment",
          args: {
            key: "owner/repo#42:src/app.ts:16:new-null-branch",
            path: "src/app.ts",
            line: 16,
            body: "The synchronized diff adds a nullable branch without coverage."
          }
        }
      ]
    },
    { finishReason: "done" }
  ]);
}

export function createPrReviewTools(comments: Map<string, SimulatedComment>): AnyTool[] {
  return createSimulatedGitHubTools({ comments });
}

if (import.meta.main) {
  const result = await runPrReviewSimulation({ store: new MemorySessionStore() });
  console.log(JSON.stringify(result, null, 2));
}

export function simulatedPrReviewProfile(): Profile {
  return defineProfile({
    name: "pr-review",
    mode: "automation",
    systemPrompt:
      "You review pull requests. Comment only on concrete, actionable issues and avoid duplicate findings.",
    skills: [],
    tools: [
      "get_diff",
      "get_file_at_ref",
      "get_pr_metadata",
      "get_prior_comments",
      "post_inline_comment",
      "post_review"
    ],
    sandboxPolicy: { kind: "local" },
    modelDefaults: {},
    policy: { toolError: "fail", maxSteps: 32 },
    sessionKey: "review:{payload.repo}#{payload.pr}"
  });
}
