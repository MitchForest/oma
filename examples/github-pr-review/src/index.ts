#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { renderInProgressSummary } from "./comments";
import { GithubClient, commentIdFromGithubEvent } from "./github";
import { loadFixtureContext, loadFixtureFindings } from "./fixtures";
import { runReview } from "./run";
import { reviewRequestFromFixture, reviewRequestFromGithubEvent } from "./trigger";
import type { PullRequestContext, ReviewRunResult } from "./types";
import type { ReasoningEffort } from "./openai-reviewer";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    return args[index + 1];
  }
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

function boolArg(args: string[], name: string, defaultValue: boolean): boolean {
  const value = argValue(args, name);
  if (value === undefined) {
    return defaultValue;
  }
  return value !== "false";
}

function reasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error("Reasoning effort must be low, medium, high, or xhigh.");
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const fixtureDir = argValue(args, "--fixture");
  const dryRun = boolArg(args, "--dry-run", true);
  const cwd = process.cwd();
  const runUrl = process.env.GITHUB_ACTION_RUN_URL;

  let context: PullRequestContext;
  let fixtureFindings;
  let client: GithubClient | undefined;
  let triggerCommentId: number | undefined;

  if (fixtureDir) {
    const request = await reviewRequestFromFixture(fixtureDir);
    context = await loadFixtureContext({ fixtureDir, request });
    fixtureFindings = await loadFixtureFindings(fixtureDir);
  } else {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
      throw new Error("GITHUB_EVENT_PATH is required unless --fixture is provided.");
    }
    const request = await reviewRequestFromGithubEvent({
      eventPath,
      env: process.env,
    });
    if (!request) {
      console.log("No OMA review trigger found; exiting.");
      return 0;
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN is required for non-fixture runs.");
    }
    client = new GithubClient({ token });
    const event = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
    triggerCommentId = commentIdFromGithubEvent(event);
    context = await client.fetchPullRequestContext(request);
    if (triggerCommentId) {
      await client.addEyesReaction(context.request, triggerCommentId);
    }
    await client.setReviewStatus(context.request, {
      state: "pending",
      description: "Review in progress",
      targetUrl: runUrl,
    });
    await client.upsertSummaryBody(
      context.request,
      renderInProgressSummary({
        context,
        runUrl,
      }),
    );
  }

  const runInput: Parameters<typeof runReview>[0] = {
    cwd,
    context,
  };
  const workspacePath = argValue(args, "--workspace") ?? process.env.OMA_REVIEW_WORKSPACE;
  if (workspacePath) {
    runInput.workspacePath = workspacePath;
  }
  const reviewConfigPath = argValue(args, "--review-config");
  if (reviewConfigPath) {
    runInput.reviewConfigPath = reviewConfigPath;
  }
  if (fixtureFindings) {
    runInput.fixtureFindings = fixtureFindings;
  }
  if (process.env.OPENAI_API_KEY) {
    runInput.openAIApiKey = process.env.OPENAI_API_KEY;
  }
  const model = argValue(args, "--model") ?? process.env.OPENAI_MODEL;
  if (model) {
    runInput.openAIModel = model;
  }
  const effort = reasoningEffort(
    argValue(args, "--reasoning-effort") ?? process.env.OPENAI_REASONING_EFFORT,
  );
  if (effort) {
    runInput.openAIReasoningEffort = effort;
  }

  let result: ReviewRunResult;
  try {
    result = await runReview(runInput);
  } catch (error) {
    if (client && !fixtureDir) {
      await client.setReviewStatus(context.request, {
        state: "failure",
        description: "Review failed",
        targetUrl: runUrl,
      });
      if (triggerCommentId) {
        await client.addReaction(context.request, triggerCommentId, "confused");
      }
    }
    throw error;
  }

  if (dryRun || fixtureDir) {
    console.log(
      JSON.stringify({ dryRun: true, status: result.outcome.status, plan: result.plan }, null, 2),
    );
    return result.outcome.status === "succeeded" ? 0 : 1;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required to publish review output.");
  }
  client = client ?? new GithubClient({ token });
  await client.upsertSummary(context.request, result.plan);
  await client.publishInlineReview(context.request, result.plan);
  await client.setReviewStatus(context.request, {
    state: result.outcome.status === "succeeded" ? "success" : "failure",
    description:
      result.findings.findings.length === 0
        ? "No high-signal findings"
        : `${String(result.plan.stats.totalOpen)} open findings, ${String(result.plan.stats.resolvedSinceLastRun)} resolved`,
    targetUrl: runUrl,
  });
  if (triggerCommentId && result.findings.findings.length === 0) {
    await client.addReaction(context.request, triggerCommentId, "+1");
  }

  return result.outcome.status === "succeeded" ? 0 : 1;
}

const exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  return 1;
});

process.exit(exitCode);
