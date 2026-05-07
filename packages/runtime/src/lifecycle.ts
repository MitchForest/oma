import { statusFromValidation } from "./outcome";
import type {
  Artifact,
  BoundEnvironment,
  Event,
  HarnessObservedEvent,
  HarnessObservationInput,
  Objective,
  Outcome,
  Session,
  ValidationResult,
  Validator,
} from "./types";

export async function emit<TEvent extends Event>(
  session: Session,
  event: Omit<TEvent, "id" | "schemaVersion" | "sequence" | "sessionId" | "at">,
): Promise<TEvent> {
  return await session.append({
    ...event,
    at: new Date().toISOString(),
  } as Omit<TEvent, "id" | "schemaVersion" | "sequence" | "sessionId">);
}

export async function failRun(input: {
  runId: string;
  objective: Objective;
  session: Session;
  message: string;
}): Promise<Outcome> {
  await emit(sessionFrom(input), {
    runId: input.runId,
    type: "run.failed",
    data: {
      status: "failed",
      message: input.message,
    },
  });

  return {
    runId: input.runId,
    status: "failed",
    objective: input.objective,
    artifacts: [],
    validation: [],
    events: await input.session.events(),
  };
}

export async function appendArtifacts(input: {
  runId: string;
  session: Session;
  artifacts: Artifact[];
}): Promise<void> {
  for (const artifact of input.artifacts) {
    await emit(input.session, {
      runId: input.runId,
      type: "artifact.produced",
      data: {
        artifact,
      },
    });
  }
}

export async function completeHarness(input: {
  runId: string;
  session: Session;
  artifacts: Artifact[];
}): Promise<void> {
  await emit(input.session, {
    runId: input.runId,
    type: "harness.completed",
    data: {
      artifactCount: input.artifacts.length,
    },
  });
}

export async function observeHarness(input: {
  runId: string;
  session: Session;
  harnessId: string;
  observation: HarnessObservationInput;
}): Promise<HarnessObservedEvent> {
  return await emit(input.session, {
    runId: input.runId,
    type: "harness.observed",
    data: {
      harnessId: input.harnessId,
      ...input.observation,
    },
  });
}

export async function runValidators(input: {
  runId: string;
  objective: Objective;
  artifacts: Artifact[];
  environment: BoundEnvironment;
  session: Session;
  validators: Validator[];
  completedValidatorIds?: Set<string>;
}): Promise<ValidationResult[]> {
  const validation: ValidationResult[] = [];
  const completed = input.completedValidatorIds ?? new Set<string>();

  for (const validator of input.validators) {
    if (completed.has(validator.id)) {
      continue;
    }

    await emit(input.session, {
      runId: input.runId,
      type: "validation.started",
      data: {
        validatorId: validator.id,
      },
    });

    let result: ValidationResult;

    try {
      result = await validator.validate({
        objective: input.objective,
        artifacts: input.artifacts,
        environment: input.environment,
        session: input.session,
      });
    } catch (error) {
      result = {
        validatorId: validator.id,
        status: "failed",
        evidence: [
          {
            kind: "text",
            message: error instanceof Error ? error.message : "Validator failed.",
          },
        ],
      };
    }

    validation.push(result);

    await emit(input.session, {
      runId: input.runId,
      type: "validation.completed",
      data: {
        result,
      },
    });
  }

  return validation;
}

export async function completeRun(input: {
  runId: string;
  objective: Objective;
  artifacts: Artifact[];
  validation: ValidationResult[];
  session: Session;
}): Promise<Outcome> {
  const status = statusFromValidation(input.validation);

  await emit(input.session, {
    runId: input.runId,
    type: "run.completed",
    data: {
      status,
    },
  });

  return {
    runId: input.runId,
    status,
    objective: input.objective,
    artifacts: input.artifacts,
    validation: input.validation,
    events: await input.session.events(),
  };
}

function sessionFrom(input: { session: Session }): Session {
  return input.session;
}
