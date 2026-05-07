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
import {
  parseFindingsArtifact,
  renderFindingsMarkdown,
  renderFixPromptsMarkdown,
} from "./findings";
import { openAIReadOnlyReviewHarness } from "./openai-reviewer";
import { buildReviewObjective } from "./objective";
import { loadRepositoryInstructions, loadReviewConfig } from "./review-config";
import type { ReasoningEffort } from "./openai-reviewer";
import type { PullRequestContext, ReviewFindingsArtifact, ReviewRunResult } from "./types";

const metadataPath = ".oma/pr-review-metadata.json";
const diffPath = ".oma/pr-review-diff.patch";
const objectivePath = ".oma/pr-review-objective.json";
const summaryPath = ".oma/pr-review-summary.md";
const findingsJsonPath = ".oma/pr-review-findings.json";
const findingsMarkdownPath = ".oma/pr-review-findings.md";
const fixPromptsPath = ".oma/pr-review-fix-prompts.md";
const configArtifactPath = ".oma/pr-review-config.json";
const reviewArtifactNames = new Set([
  summaryPath,
  findingsJsonPath,
  findingsMarkdownPath,
  fixPromptsPath,
  metadataPath,
  diffPath,
  objectivePath,
  configArtifactPath,
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

function failureMessage(outcome: ReviewRunResult["outcome"]): string | undefined {
  const failed = [...outcome.events].reverse().find((event) => event.type === "run.failed");
  if (!failed || failed.type !== "run.failed") {
    return undefined;
  }
  return typeof failed.data.message === "string" ? failed.data.message : undefined;
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
      const fixPrompts = renderFixPromptsMarkdown(input.fixtureFindings);

      await writeArtifactFile(input.root, summaryPath, `${summary}\n`);
      await writeArtifactFile(input.root, findingsJsonPath, findingsJson);
      await writeArtifactFile(input.root, findingsMarkdownPath, findingsMarkdown);
      await writeArtifactFile(input.root, fixPromptsPath, fixPrompts);
    }

    for (const artifact of baseArtifacts) {
      if (reviewArtifactNames.has(artifact.name)) {
        await writeArtifactFile(input.root, artifact.name, artifact.content);
      }
    }

    const findings = parseFindingsArtifact(
      await readFile(resolve(input.root, findingsJsonPath), "utf8"),
    );
    await writeArtifactFile(input.root, fixPromptsPath, renderFixPromptsMarkdown(findings));

    const reviewArtifacts = await Promise.all([
      collectTextArtifact(input.root, summaryPath, "text/markdown"),
      collectTextArtifact(input.root, findingsJsonPath, "application/json"),
      collectTextArtifact(input.root, findingsMarkdownPath, "text/markdown"),
      collectTextArtifact(input.root, fixPromptsPath, "text/markdown"),
      collectTextArtifact(input.root, metadataPath, "application/json"),
      collectTextArtifact(input.root, diffPath, "text/x-diff"),
      collectTextArtifact(input.root, objectivePath, "application/json"),
      collectTextArtifact(input.root, configArtifactPath, "application/json"),
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
  workspacePath?: string;
  instructionWorkspacePath?: string;
  reviewConfigPath?: string;
  context: PullRequestContext;
  fixtureFindings?: ReviewFindingsArtifact;
  openAIApiKey?: string;
  openAIModel?: string;
  openAIReasoningEffort?: ReasoningEffort;
}): Promise<ReviewRunResult> {
  const loadedProject = await loadProject({
    cwd: input.cwd,
    configPath: input.configPath ?? "examples/github-pr-review/oma.config.json",
  });
  const project = input.workspacePath
    ? {
        ...loadedProject,
        workspace: resolve(input.workspacePath),
      }
    : loadedProject;
  const reviewConfig = await loadReviewConfig({
    root: project.root,
    configPath: input.reviewConfigPath,
  });
  const repositoryInstructions = await loadRepositoryInstructions({
    workspace: input.instructionWorkspacePath
      ? resolve(input.instructionWorkspacePath)
      : project.workspace,
    files: reviewConfig.instructionFiles,
    maxBytes: reviewConfig.maxInstructionBytes,
  });
  const context: PullRequestContext = {
    ...input.context,
    repositoryInstructions,
  };
  const objective = buildReviewObjective(context);

  await writeArtifactFile(project.root, metadataPath, `${JSON.stringify(context, null, 2)}\n`);
  await writeArtifactFile(project.root, diffPath, context.diff);
  await writeArtifactFile(project.root, objectivePath, `${JSON.stringify(objective, null, 2)}\n`);
  await writeArtifactFile(
    project.root,
    configArtifactPath,
    `${JSON.stringify(reviewConfig, null, 2)}\n`,
  );

  const store = createSessionStore(project);
  const session = await store.create();
  const environment = createEnvironment(project);
  const validators = createValidators(project);
  let baseHarness: Harness | undefined;
  if (!input.fixtureFindings) {
    const openAIHarnessInput: Parameters<typeof openAIReadOnlyReviewHarness>[0] = {
      apiKey: input.openAIApiKey ?? requireOpenAIApiKey(),
      context,
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
    const message = failureMessage(outcome);
    throw new Error(
      message
        ? `Review run did not produce findings artifact: ${message}`
        : `Review run did not produce findings artifact. Outcome status: ${outcome.status}`,
    );
  }

  const findings = JSON.parse(findingsArtifact.content) as ReviewFindingsArtifact;
  const plan = planReviewComments({
    context,
    artifact: findings,
    policy: reviewConfig,
  });

  return {
    outcome,
    findings,
    plan,
  };
}
