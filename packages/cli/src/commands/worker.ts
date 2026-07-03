import { hostname } from "node:os";
import { ClaimHeldError, hasSessionProjections, sessionStoreCapabilities } from "@oma/core";
import { numberFlag, parseArgs } from "../args";
import { loadRuntime, resumeWorkflowSession, type RuntimeBundle } from "../runtime";

const workerUsage =
  "Usage: oma worker [--name <name>] [--poll <ms>] [--once] [--json]";

/**
 * A worker is the same stateless harness pointed at the same store: it polls
 * for unfinished workflow sessions, claims one under a durable lease, resumes
 * it with its own placement identity, and releases. If it dies mid-run, the
 * lease expires and any other worker takes over from the log.
 */
export async function workerCommand(args: string[]): Promise<number | void> {
  const parsed = parseArgs(args, {
    flags: ["once", "json"],
    values: ["name", "poll"]
  });
  const name = parsed.values.get("name") ?? hostname();
  const placement = `worker:${name}`;
  const bundle = await loadRuntime(".oma/config.json", { workerId: placement });
  const pollMs = numberFlag(parsed, "poll", { integer: true, min: 100 }) ?? 2_000;
  const json = parsed.flags.has("json");

  if (!hasSessionProjections(bundle.store)) {
    throw new Error("Configured store does not support session listing; workers need projections.");
  }

  if (!sessionStoreCapabilities(bundle.store).runClaims) {
    console.error(
      "warning: store has no durable run claims; two workers could wake the same session"
    );
  }

  if (!json) {
    console.log(`worker ${placement} polling every ${pollMs}ms`);
  }

  for (;;) {
    const results = await workerPass(bundle, placement, json);

    if (parsed.flags.has("once")) {
      if (json) {
        console.log(JSON.stringify(results, null, 2));
      }

      return results.some((result) => result.status === "failed") ? 1 : 0;
    }

    await Bun.sleep(pollMs);
  }
}

interface WorkerPassResult {
  sessionId: string;
  status: string;
  reason?: string;
}

async function workerPass(
  bundle: RuntimeBundle,
  placement: string,
  json: boolean
): Promise<WorkerPassResult[]> {
  if (!hasSessionProjections(bundle.store)) {
    return [];
  }

  const sessions = await bundle.store.listSessions();
  const results: WorkerPassResult[] = [];

  for (const session of sessions) {
    if (
      typeof session.metadata?.workflowPath !== "string" ||
      session.status === "completed" ||
      session.status === "failed"
    ) {
      continue;
    }

    try {
      const { result } = await resumeWorkflowSession(bundle, session.id, { placement });

      results.push({ sessionId: session.id, status: result.status, reason: result.reason });

      if (!json) {
        console.log(
          `worker ${placement}: ${session.id} -> ${result.status}${result.reason ? ` (${result.reason})` : ""}`
        );
      }
    } catch (error) {
      if (error instanceof ClaimHeldError) {
        // Another worker is on it; that is the system working.
        continue;
      }

      results.push({
        sessionId: session.id,
        status: "error",
        reason: error instanceof Error ? error.message : String(error)
      });

      if (!json) {
        console.error(
          `worker ${placement}: ${session.id} error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  return results;
}
