import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEnvironment,
  createSessionStore,
  createValidators,
  loadProject,
  writeOutcomeFiles,
} from "@oma/project";
import { artifacts, harnesses, run } from "@oma/runtime";
import type { Artifact, Harness } from "@oma/runtime";
import { planReviewComments } from "./comments";
import { renderFindingsMarkdown } from "./findings";
import { openAIReadOnlyReviewHarness } from "./openai-reviewer";
import { buildReviewObjective } from "./objective";
import type { ReasoningEffort } from "./openai-reviewer";
import type { PullRequestContext, ReviewFindingsArtifact, ReviewRunResult } from "./types";

const metadataPath = ".oma/pr-review-metadata.json";
const diffPath = ".oma/pr-review-diff.patch";
const objectivePath = ".oma/pr-review-objective.json";
const summaryPath = ".oma/pr-review-summary.md";
const findingsJsonPath = ".oma/pr-review-findings.json";
const findingsMarkdownPath = ".oma/pr-review-findings.md";
const reviewArtifactNames = new Set([
  summaryPath,
  findingsJsonPath,
  findingsMarkdownPath,
  metadataPath,
  diffPath,
  objectivePath,
]);

async function writeArtifactFile(root: string, path: string, content: string): Promise<void> {
  await mkdir(resolve(root, ".oma"), { recursive: true });
  await writeFile(resolve(root, path), content);
}

async function collectTextArtifact(
  root: string,
  path: string,
  mediaType: string,
): Promise<Artifact> {
  return artifacts.custom({
    name: path,
    mediaType,
    content: await readFile(resolve(root, path), "utf8"),
  });
}

function requireOpenAIApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for real PR review runs.");
  }
  return apiKey;
}

function reviewHarness(input: {
  root: string;
  baseHarness?: Harness;
  fixtureFindings?: ReviewFindingsArtifact;
}): Harness {
  return harnesses.custom(async (harnessInput) => {
    const baseArtifacts = input.baseHarness
      ? (await input.baseHarness.run(harnessInput)).artifacts
      : [];

    if (input.fixtureFindings) {
      const summary = input.fixtureFindings.summary;
      const findingsJson = `${JSON.stringify(input.fixtureFindings, null, 2)}\n`;
      const findingsMarkdown = renderFindingsMarkdown(input.fixtureFindings);

      await writeArtifactFile(input.root, summaryPath, `${summary}\n`);
      await writeArtifactFile(input.root, findingsJsonPath, findingsJson);
      await writeArtifactFile(input.root, findingsMarkdownPath, findingsMarkdown);
    }

    for (const artifact of baseArtifacts) {
      if (reviewArtifactNames.has(artifact.name)) {
        await writeArtifactFile(input.root, artifact.name, artifact.content);
      }
    }

    const reviewArtifacts = await Promise.all([
      collectTextArtifact(input.root, summaryPath, "text/markdown"),
      collectTextArtifact(input.root, findingsJsonPath, "application/json"),
      collectTextArtifact(input.root, findingsMarkdownPath, "text/markdown"),
      collectTextArtifact(input.root, metadataPath, "application/json"),
      collectTextArtifact(input.root, diffPath, "text/x-diff"),
      collectTextArtifact(input.root, objectivePath, "application/json"),
    ]);

    return {
      artifacts: [
        ...baseArtifacts.filter((artifact) => !reviewArtifactNames.has(artifact.name)),
        ...reviewArtifacts,
      ],
    };
  });
}

export async function runReview(input: {
  cwd: string;
  configPath?: string;
  context: PullRequestContext;
  fixtureFindings?: ReviewFindingsArtifact;
  openAIApiKey?: string;
  openAIModel?: string;
  openAIReasoningEffort?: ReasoningEffort;
}): Promise<ReviewRunResult> {
  const project = await loadProject({
    cwd: input.cwd,
    configPath: input.configPath ?? "examples/github-pr-review/oma.config.json",
  });
  const objective = buildReviewObjective(input.context);

  await writeArtifactFile(
    project.root,
    metadataPath,
    `${JSON.stringify(input.context, null, 2)}\n`,
  );
  await writeArtifactFile(project.root, diffPath, input.context.diff);
  await writeArtifactFile(project.root, objectivePath, `${JSON.stringify(objective, null, 2)}\n`);

  const store = createSessionStore(project);
  const session = await store.create();
  const environment = createEnvironment(project);
  const validators = createValidators(project);
  let baseHarness: Harness | undefined;
  if (!input.fixtureFindings) {
    const openAIHarnessInput: Parameters<typeof openAIReadOnlyReviewHarness>[0] = {
      apiKey: input.openAIApiKey ?? requireOpenAIApiKey(),
      context: input.context,
    };
    if (input.openAIModel) {
      openAIHarnessInput.model = input.openAIModel;
    }
    if (input.openAIReasoningEffort) {
      openAIHarnessInput.reasoningEffort = input.openAIReasoningEffort;
    }
    baseHarness = openAIReadOnlyReviewHarness(openAIHarnessInput);
  }

  const harnessInput: Parameters<typeof reviewHarness>[0] = {
    root: project.root,
  };
  if (baseHarness) {
    harnessInput.baseHarness = baseHarness;
  }
  if (input.fixtureFindings) {
    harnessInput.fixtureFindings = input.fixtureFindings;
  }

  const outcome = await run({
    objective,
    process: {
      session,
      harness: reviewHarness(harnessInput),
    },
    environment,
    validation: validators,
  });

  await writeOutcomeFiles(project, outcome);

  const findingsArtifact = outcome.artifacts.find((artifact) => artifact.name === findingsJsonPath);
  if (!findingsArtifact) {
    throw new Error("Review run did not produce findings artifact.");
  }

  const findings = JSON.parse(findingsArtifact.content) as ReviewFindingsArtifact;
  const plan = planReviewComments({
    context: input.context,
    artifact: findings,
  });

  return {
    outcome,
    findings,
    plan,
  };
}
