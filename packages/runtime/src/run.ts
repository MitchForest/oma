import { createId } from "./ids";
import {
  appendArtifacts,
  completeHarness,
  completeRun,
  emit,
  failRun,
  observeHarness,
  runValidators,
} from "./lifecycle";
import type { Artifact, Outcome, RunInput, RunOptions } from "./types";

export async function run(input: RunInput, options: RunOptions = {}): Promise<Outcome> {
  const runId = options.runId ?? createId("run");
  const { objective, process, environment } = input;
  const validators = input.validation ?? [];
  const harnessId = process.harness.id ?? "unknown";
  const boundEnvironment = environment.bind({
    runId,
    session: process.session,
  });

  await emit(process.session, {
    runId,
    type: "run.started",
    data: {
      objective,
    },
  });

  if (options.stopAfter === "run.started") {
    return {
      runId,
      status: "partial",
      objective,
      artifacts: [],
      validation: [],
      events: await process.session.events(),
    };
  }

  await emit(process.session, {
    runId,
    type: "harness.started",
    data: {},
  });

  if (options.stopAfter === "harness.started") {
    return {
      runId,
      status: "partial",
      objective,
      artifacts: [],
      validation: [],
      events: await process.session.events(),
    };
  }

  let artifacts: Artifact[];

  try {
    const result = await process.harness.run({
      runId,
      objective,
      environment: boundEnvironment,
      session: process.session,
      observe: async (observation) =>
        await observeHarness({
          runId,
          session: process.session,
          harnessId,
          observation,
        }),
    });
    artifacts = result.artifacts;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Harness failed.";
    return await failRun({
      runId,
      objective,
      session: process.session,
      message,
    });
  }

  await completeHarness({ runId, session: process.session, artifacts });
  await appendArtifacts({ runId, session: process.session, artifacts });

  if (options.stopAfter === "artifacts.produced") {
    return {
      runId,
      status: "partial",
      objective,
      artifacts,
      validation: [],
      events: await process.session.events(),
    };
  }

  const validation = await runValidators({
    runId,
    objective,
    artifacts,
    environment: boundEnvironment,
    session: process.session,
    validators,
  });

  return await completeRun({
    runId,
    objective,
    artifacts,
    validation,
    session: process.session,
  });
}
