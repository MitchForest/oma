import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { Objective, OutcomeStatus } from "@oma/runtime";
import type { ServerJobStatus, ServerRunRecord } from "./types";

type RunRow = {
  run_id: string;
  session_id: string;
  status: ServerJobStatus;
  objective: string;
  created_at: string;
  updated_at: string;
  outcome_json_path: string | null;
  outcome_markdown_path: string | null;
  error: string | null;
};

function rowToRun(row: RunRow): ServerRunRecord {
  const output: ServerRunRecord = {
    runId: row.run_id,
    sessionId: row.session_id,
    status: row.status,
    objective: JSON.parse(row.objective) as Objective,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (row.outcome_json_path) {
    output.outcomeJsonPath = row.outcome_json_path;
  }
  if (row.outcome_markdown_path) {
    output.outcomeMarkdownPath = row.outcome_markdown_path;
  }
  if (row.error) {
    output.error = row.error;
  }

  return output;
}

export type ServerStore = {
  close(): void;
  createRun(input: { runId: string; sessionId: string; objective: Objective }): ServerRunRecord;
  listRuns(): ServerRunRecord[];
  getRun(runId: string): ServerRunRecord | undefined;
  claimNextRun(): ServerRunRecord | undefined;
  markQueued(runId: string): void;
  markCancelled(runId: string): void;
  completeRun(input: {
    runId: string;
    status: OutcomeStatus;
    outcomeJsonPath: string;
    outcomeMarkdownPath: string;
  }): void;
  failRun(input: { runId: string; error: string }): void;
};

export async function createServerStore(path: string): Promise<ServerStore> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    create table if not exists server_runs (
      run_id text primary key,
      session_id text not null,
      status text not null,
      objective text not null,
      created_at text not null,
      updated_at text not null,
      outcome_json_path text,
      outcome_markdown_path text,
      error text
    );
  `);

  db.query("update server_runs set status = 'queued', updated_at = ? where status = 'running'").run(
    new Date().toISOString(),
  );

  function getRun(runId: string): ServerRunRecord | undefined {
    const row = db.query("select * from server_runs where run_id = ?").get(runId) as RunRow | null;
    return row ? rowToRun(row) : undefined;
  }

  const store: ServerStore = {
    close() {
      db.close();
    },

    createRun(input) {
      const now = new Date().toISOString();
      db.query(`
        insert into server_runs (
          run_id,
          session_id,
          status,
          objective,
          created_at,
          updated_at
        )
        values (?, ?, 'queued', ?, ?, ?)
      `).run(input.runId, input.sessionId, JSON.stringify(input.objective), now, now);

      return getRun(input.runId) as ServerRunRecord;
    },

    listRuns() {
      const rows = db.query("select * from server_runs order by created_at desc").all() as RunRow[];
      return rows.map(rowToRun);
    },

    getRun(runId) {
      return getRun(runId);
    },

    claimNextRun() {
      const row = db
        .query("select * from server_runs where status = 'queued' order by created_at asc limit 1")
        .get() as RunRow | null;

      if (!row) {
        return undefined;
      }

      db.query("update server_runs set status = 'running', updated_at = ? where run_id = ?").run(
        new Date().toISOString(),
        row.run_id,
      );

      return getRun(row.run_id);
    },

    markQueued(runId) {
      db.query("update server_runs set status = 'queued', updated_at = ? where run_id = ?").run(
        new Date().toISOString(),
        runId,
      );
    },

    markCancelled(runId) {
      db.query("update server_runs set status = 'cancelled', updated_at = ? where run_id = ?").run(
        new Date().toISOString(),
        runId,
      );
    },

    completeRun(input) {
      db.query(`
        update server_runs
        set status = ?,
            updated_at = ?,
            outcome_json_path = ?,
            outcome_markdown_path = ?,
            error = null
        where run_id = ?
      `).run(
        input.status,
        new Date().toISOString(),
        input.outcomeJsonPath,
        input.outcomeMarkdownPath,
        input.runId,
      );
    },

    failRun(input) {
      db.query(`
        update server_runs
        set status = 'failed',
            updated_at = ?,
            error = ?
        where run_id = ?
      `).run(new Date().toISOString(), input.error, input.runId);
    },
  };

  return store;
}
