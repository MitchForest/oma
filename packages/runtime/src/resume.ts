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
import { replay, replayOutcome } from "./replay";
import type { Artifact, Outcome, ResumeInput, ValidationResult } from "./types";

function isTerminal(status: string): boolean {
  return !["not_started", "running"].includes(status);
}

export async function resume(input: ResumeInput): Promise<Outcome> {
  const { process, environment } = input;
  const projection = await replay(process.session);

  if (isTerminal(projection.status)) {
    const replayed = await replayOutcome(process.session);
    if (replayed.ok) {
      return replayed.outcome;
    }
  }

  const runId = projection.runId ?? createId("run");
  const objective = projection.objective ?? input.objective;
  const validators = input.validation ?? [];
  const harnessId = process.harness.id ?? "unknown";
  const boundEnvironment = environment.bind({
    runId,
    session: process.session,
  });

  if (projection.status === "not_started") {
    await emit(process.session, {
      runId,
      type: "run.started",
      data: {
        objective,
      },
    });
  }

  let artifacts: Artifact[] = [...projection.artifacts];

  if (!projection.harnessCompleted) {
    if (!projection.harnessStarted) {
      await emit(process.session, {
        runId,
        type: "harness.started",
        data: {},
      });
    }

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
  }

  const completedValidatorIds = new Set(projection.validation.map((result) => result.validatorId));
  const validation: ValidationResult[] = [...projection.validation];

  validation.push(
    ...(await runValidators({
      runId,
      objective,
      artifacts,
      environment: boundEnvironment,
      session: process.session,
      validators,
      completedValidatorIds,
    })),
  );

  return await completeRun({
    runId,
    objective,
    artifacts,
    validation,
    session: process.session,
  });
}
