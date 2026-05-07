import { statusFromValidation } from "./outcome";
import type {
  Artifact,
  Event,
  Outcome,
  OutcomeStatus,
  RunProjection,
  Session,
  SessionDiagnostic,
  StoredEvent,
  ValidationResult,
} from "./types";

const knownEventTypes = new Set([
  "run.started",
  "harness.started",
  "harness.completed",
  "harness.observed",
  "artifact.produced",
  "validation.started",
  "validation.completed",
  "run.completed",
  "run.failed",
  "environment.command.started",
  "environment.command.output",
  "environment.command.exited",
  "environment.command.timed_out",
  "environment.command.failed",
  "environment.filesystem.read",
  "environment.filesystem.wrote",
  "environment.git.status",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function terminalStatus(status: RunProjection["status"]): status is OutcomeStatus {
  return !["not_started", "running"].includes(status);
}

function hasStructuralDiagnostics(diagnostics: SessionDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    [
      "unknown_event_type",
      "invalid_event_data",
      "sequence_gap",
      "schema_version_unsupported",
    ].includes(diagnostic.code),
  );
}

function validateEvent(event: StoredEvent, expectedSequence: number): SessionDiagnostic[] {
  const diagnostics: SessionDiagnostic[] = [];

  if (event.schemaVersion !== 1) {
    diagnostics.push({
      code: "schema_version_unsupported",
      message: `Unsupported event schema version: ${String(event.schemaVersion)}`,
      sequence: event.sequence,
    });
  }

  if (event.sequence !== expectedSequence) {
    diagnostics.push({
      code: "sequence_gap",
      message: `Expected event sequence ${expectedSequence}, received ${event.sequence}.`,
      sequence: event.sequence,
    });
  }

  if (!knownEventTypes.has(event.type)) {
    diagnostics.push({
      code: "unknown_event_type",
      message: `Unknown event type: ${event.type}`,
      sequence: event.sequence,
    });
  }

  if (!isRecord(event.data)) {
    diagnostics.push({
      code: "invalid_event_data",
      message: "Event data must be an object.",
      sequence: event.sequence,
    });
  }

  return diagnostics;
}

export async function replay(session: Session): Promise<RunProjection> {
  const events = await session.events();
  const projection: RunProjection = {
    sessionId: session.id,
    status: "not_started",
    harnessStarted: false,
    harnessCompleted: false,
    artifacts: [],
    validation: [],
    events,
    diagnostics: [],
  };

  for (const [index, event] of events.entries()) {
    projection.diagnostics.push(...validateEvent(event, index + 1));

    switch (event.type) {
      case "run.started": {
        const data = event.data as EventOf<"run.started">["data"];
        projection.runId = event.runId;
        projection.objective = data.objective;
        projection.status = "running";
        break;
      }

      case "artifact.produced": {
        const data = event.data as { artifact?: Artifact };
        if (data.artifact) {
          projection.artifacts.push(data.artifact);
        } else {
          projection.diagnostics.push({
            code: "invalid_event_data",
            message: "artifact.produced is missing data.artifact.",
            sequence: event.sequence,
          });
        }
        break;
      }

      case "harness.started": {
        projection.harnessStarted = true;
        break;
      }

      case "harness.completed": {
        projection.harnessCompleted = true;
        break;
      }

      case "validation.completed": {
        const data = event.data as { result?: ValidationResult };
        if (data.result) {
          projection.validation.push(data.result);
        } else {
          projection.diagnostics.push({
            code: "invalid_event_data",
            message: "validation.completed is missing data.result.",
            sequence: event.sequence,
          });
        }
        break;
      }

      case "run.completed": {
        const data = event.data as { status?: OutcomeStatus };
        projection.status = data.status ?? statusFromValidation(projection.validation);
        break;
      }

      case "run.failed": {
        const data = event.data as { status?: "blocked" | "failed" };
        projection.status = data.status ?? "failed";
        break;
      }

      default:
        break;
    }
  }

  return projection;
}

export async function replayOutcome(session: Session) {
  const projection = await replay(session);

  if (!terminalStatus(projection.status)) {
    return {
      ok: false,
      reason: "not_terminal",
      diagnostics: [
        ...projection.diagnostics,
        {
          code: "not_terminal",
          message: "Session has no terminal run event.",
        } satisfies SessionDiagnostic,
      ],
      projection,
    } as const;
  }

  if (!projection.runId || !projection.objective) {
    return {
      ok: false,
      reason: "invalid_session",
      diagnostics: [
        ...projection.diagnostics,
        {
          code: "missing_objective",
          message: "Session is terminal but does not include a run.started objective.",
        } satisfies SessionDiagnostic,
      ],
      projection,
    } as const;
  }

  if (hasStructuralDiagnostics(projection.diagnostics)) {
    return {
      ok: false,
      reason: "invalid_session",
      diagnostics: projection.diagnostics,
      projection,
    } as const;
  }

  const outcome: Outcome = {
    runId: projection.runId,
    status: projection.status,
    objective: projection.objective,
    artifacts: projection.artifacts,
    validation: projection.validation,
    events: projection.events,
  };

  return {
    ok: true,
    outcome,
  } as const;
}

type EventOf<TType extends Event["type"]> = Extract<Event, { type: TType }>;
