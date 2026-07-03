import { send, type TriggerSignal } from "@oma/core";
import {
  defaultWorkflowDir,
  isWorkflowPath,
  listWorkflowFiles,
  requireLoadedWorkflow
} from "@oma/workflows";
import { numberFlag, parseArgs } from "../args";
import { createUiServer } from "../ui";
import {
  loadRuntime,
  resumeSessionSmart,
  routeWorkflowSignal,
  type RuntimeBundle
} from "../runtime";

const serveUsage =
  "Usage: oma serve webhooks [workflow.yml|workflowDir] [--port <n>] [--secret <value>] [--github-secret <value>] [--sentry-secret <value>]";

export async function serveCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand !== "webhooks") {
    throw new Error(serveUsage);
  }

  const parsed = parseArgs(rest, {
    values: ["port", "secret", "github-secret", "sentry-secret", "max-steps"]
  });
  const [target] = parsed.positionals;
  const bundle = await loadRuntime();
  const maxSteps = numberFlag(parsed, "max-steps", { integer: true, min: 1 });
  const dispatch = await createServeDispatch(bundle, target, maxSteps);
  const githubSecret =
    parsed.values.get("github-secret") ?? process.env.GITHUB_WEBHOOK_SECRET;

  if (!githubSecret) {
    console.error(
      "warning: serving GitHub webhooks without signature verification; pass --github-secret or set GITHUB_WEBHOOK_SECRET"
    );
  }

  const sentrySecret =
    parsed.values.get("sentry-secret") ?? process.env.SENTRY_WEBHOOK_SECRET;
  const { createHttpTriggerServer } = await import("@oma/adapter-trigger-http");
  const { normalizeGitHubWebhook } = await import("@oma/adapter-trigger-github");
  const { normalizeSentryWebhook } = await import("@oma/adapter-trigger-sentry");
  const server = await createHttpTriggerServer({
    port: numberFlag(parsed, "port", { integer: true, min: 0 }) ?? 8787,
    secret: parsed.values.get("secret"),
    sources: {
      github: {
        normalize: ({ headers, body }) =>
          normalizeGitHubWebhook({ headers, body, secret: githubSecret })
      },
      sentry: {
        normalize: ({ headers, body }) =>
          normalizeSentryWebhook({ headers, body, secret: sentrySecret })
      }
    },
    dispatch
  });

  console.log(`webhooks listening on ${server.url}`);
  await new Promise(() => {});
}

/**
 * No target serves every workflow in `.oma/workflows/`; a `.yml`/`.yaml`
 * target serves that workflow; a directory of workflows serves all of them.
 */
async function createServeDispatch(
  bundle: RuntimeBundle,
  target: string | undefined,
  maxSteps: number | undefined
): Promise<(signal: TriggerSignal) => Promise<unknown>> {
  const workflowPaths: string[] = [];

  if (!target) {
    workflowPaths.push(...(await listWorkflowFiles(defaultWorkflowDir)));

    if (workflowPaths.length === 0) {
      throw new Error(`No workflows found in ${defaultWorkflowDir}. ${serveUsage}`);
    }
  } else if (isWorkflowPath(target)) {
    workflowPaths.push(target);
  } else {
    const dirWorkflows = await listWorkflowFiles(target);
    workflowPaths.push(...dirWorkflows);
  }

  if (workflowPaths.length === 0) {
    throw new Error(`No workflows found at ${target}. ${serveUsage}`);
  }

  // Fail fast on invalid workflows at startup; signals still reload from disk
  // per delivery so edits apply without restarting (the log records the hash
  // that actually handled each signal).
  for (const path of workflowPaths) {
    const loaded = await requireLoadedWorkflow(path);
    console.log(`workflow ${loaded.workflow.name} (${path})`);
  }

  return async (signal) => {
    for (const path of workflowPaths) {
      const output = await routeWorkflowSignal(bundle, path, signal, { maxSteps });

      if (output.route.type !== "ignored") {
        return {
          workflow: output.workflow.name,
          route: output.route,
          status: output.status
        };
      }
    }

    return { route: { type: "ignored" } };
  };
}

export async function uiCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args, { values: ["port"] });
  const bundle = await loadRuntime();
  const port = numberFlag(parsed, "port", { integer: true, min: 0 }) ?? 8788;

  const server = createUiServer({
    store: bundle.store,
    port,
    async sendMessage(sessionId, message, options = {}) {
      // The UI follows the CLI's rules: chat is for single-stage workflow
      // sessions; staged parents and stage sessions refuse it.
      const session = await bundle.store.getSession(sessionId);

      if (
        session.metadata?.workflowKind === "staged" ||
        typeof session.metadata?.parentSessionId === "string" ||
        typeof session.metadata?.workflowPath !== "string"
      ) {
        throw new Error(
          `Session ${sessionId} does not take chat; use approve/deny or run the workflow with inputs.`
        );
      }

      await send(bundle.store, sessionId, message);

      if (!options.wake) {
        return bundle.store.getSession(sessionId);
      }

      await resumeSessionSmart(bundle, sessionId);
      return bundle.store.getSession(sessionId);
    },
    async wakeSession(sessionId) {
      await resumeSessionSmart(bundle, sessionId);
      return bundle.store.getSession(sessionId);
    },
    async forkSession(sessionId, atOffset) {
      const source = await bundle.store.getSession(sessionId);
      return bundle.store.fork(sessionId, atOffset, {
        metadata: {
          ...source.metadata,
          forkedFrom: { sessionId, atOffset }
        }
      });
    }
  });

  console.log(`oma ui listening on http://localhost:${server.port}`);
  await new Promise(() => {});
}
