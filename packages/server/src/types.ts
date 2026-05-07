import type { Objective, OutcomeStatus } from "@oma/runtime";
import type { ValidationReport } from "@oma/project";

export type ServerJobStatus =
  | "queued"
  | "running"
  | "cancelled"
  | "cancel_requested"
  | OutcomeStatus;

export type ServerRunRecord = {
  runId: string;
  sessionId: string;
  status: ServerJobStatus;
  objective: Objective;
  createdAt: string;
  updatedAt: string;
  outcomeJsonPath?: string;
  outcomeMarkdownPath?: string;
  error?: string;
};

export type CreateRunRequest = {
  objective: Objective;
};
export type { ValidationReport };
