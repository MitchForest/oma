import { run, validateArtifacts } from "@oma/runtime";
import type { OutcomeStatus } from "@oma/runtime";
import {
  createEnvironment,
  createHarness,
  createServerSessionStore,
  createValidators,
  writeServerOutcomeFiles,
} from "@oma/project";
import type { EventBus } from "./events";
import { observableSession } from "./session";
import type { ServerStore } from "./store";
import type { ResolvedProject, ValidationReport } from "@oma/project";

function statusFromValidation(validation: ValidationReport["validation"]): OutcomeStatus {
  if (validation.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (validation.some((result) => result.status === "inconclusive")) {
    return "inconclusive";
  }
  return "succeeded";
}

export async function rerunValidation(input: {
  config: ResolvedProject;
  runId: string;
  outcome: Parameters<typeof validateArtifacts>[0] extends { objective: infer TObjective }
    ? {
        objective: TObjective;
        artifacts: Parameters<typeof validateArtifacts>[0]["artifacts"];
      }
    : never;
}): Promise<ValidationReport> {
  const sessionStore = createServerSessionStore(input.config);
  const validationSession = await sessionStore.create();
  const environment = createEnvironment(input.config).bind({
    runId: input.runId,
    session: validationSession,
  });
  const validation = await validateArtifacts({
    objective: input.outcome.objective,
    artifacts: input.outcome.artifacts,
    environment,
    session: validationSession,
    validators: createValidators(input.config),
  });

  return {
    schemaVersion: 1,
    runId: input.runId,
    status: statusFromValidation(validation),
    validation,
  };
}

export type Worker = {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
};

export function createWorker(input: {
  config: ResolvedProject;
  store: ServerStore;
  events: EventBus;
}): Worker {
  let running = false;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (running || stopped) {
      return;
    }

    const record = input.store.claimNextRun();
    if (!record) {
      return;
    }

    running = true;

    try {
      const sessionStore = createServerSessionStore(input.config);
      const baseSession = await sessionStore.open(record.sessionId);
      const session = observableSession({
        session: baseSession,
        onAppend: (event) => input.events.publish(record.runId, event),
      });
      const outcome = await run(
        {
          objective: record.objective,
          process: {
            session,
            harness: createHarness(input.config),
          },
          environment: createEnvironment(input.config),
          validation: createValidators(input.config),
        },
        {
          runId: record.runId,
        },
      );
      const paths = await writeServerOutcomeFiles(input.config, outcome);
      input.store.completeRun({
        runId: record.runId,
        status: outcome.status,
        outcomeJsonPath: paths.jsonPath,
        outcomeMarkdownPath: paths.markdownPath,
      });
      input.events.publish(record.runId, {
        type: "oma.done",
        data: {
          status: outcome.status,
        },
      });
    } catch (error) {
      input.store.failRun({
        runId: record.runId,
        error: error instanceof Error ? error.message : "Run failed.",
      });
      input.events.publish(record.runId, {
        type: "oma.done",
        data: {
          status: "failed",
        },
      });
    } finally {
      running = false;
      if (!stopped) {
        current = tick();
      }
    }
  }

  return {
    start() {
      stopped = false;
      current = tick();
    },

    stop() {
      stopped = true;
    },

    async drain() {
      await current;
      while (input.store.listRuns().some((runRecord) => runRecord.status === "queued")) {
        current = tick();
        await current;
      }
    },
  };
}
