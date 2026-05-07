#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { GithubClient, commentIdFromGithubEvent } from "./github";
import { loadFixtureContext, loadFixtureFindings } from "./fixtures";
import { runReview } from "./run";
import { reviewRequestFromFixture, reviewRequestFromGithubEvent } from "./trigger";
import type { ReasoningEffort } from "./openai-reviewer";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

  let context;
  let fixtureFindings;

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
    const client = new GithubClient({ token });
    const event = JSON.parse(await readFile(eventPath, "utf8")) as unknown;
    const commentId = commentIdFromGithubEvent(event);
    if (commentId) {
      await client.addEyesReaction(request, commentId);
    }
    context = await client.fetchPullRequestContext(request);
  }

  const runInput: Parameters<typeof runReview>[0] = {
    cwd,
    context,
  };
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

  const result = await runReview(runInput);

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
  const client = new GithubClient({ token });
  await client.upsertSummary(context.request, result.plan);
  await client.publishInlineReview(context.request, result.plan);

  return result.outcome.status === "succeeded" ? 0 : 1;
}

const exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  return 1;
});

process.exit(exitCode);
