import type { OutcomeStatus, ValidationResult } from "@oma/runtime";

export type HarnessKind = "claude-code" | "codex-cli" | "mock" | "opencode" | "pi";

export type SessionConfig =
  | {
      kind: "jsonl";
      dir: string;
    }
  | {
      kind: "sqlite";
      path: string;
    };

export type ValidatorConfig =
  | {
      kind: "artifactExists";
      path?: string;
      paths?: string[];
    }
  | {
      kind: "command";
      command: string;
      args?: string[];
      cwd?: string;
      id?: string;
      timeoutMs?: number;
    }
  | {
      kind: "test" | "typecheck" | "lint";
      command: string;
      args?: string[];
      cwd?: string;
      id?: string;
      timeoutMs?: number;
    }
  | {
      kind: "gitDiff";
      id?: string;
      required?: boolean;
      allowDirty?: boolean;
      maxBytes?: number;
    }
  | {
      kind: "schema";
      id?: string;
      artifact: string;
      schema: Record<string, unknown>;
    }
  | {
      kind: "all" | "any" | "sequence";
      id: string;
      validators: ValidatorConfig[];
    };

export type OmaConfig = {
  schemaVersion: 1;
  workspace: string;
  harness: {
    kind: HarnessKind;
    options?: Record<string, unknown>;
  };
  session?: SessionConfig;
  validation?: ValidatorConfig[];
};

export type ResolvedProject = {
  configPath: string;
  root: string;
  stateDir: string;
  workspace: string;
  databasePath: string;
  session: SessionConfig;
  harness: OmaConfig["harness"];
  validation: ValidatorConfig[];
};

export type RunRecord = {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  status: OutcomeStatus;
  createdAt: string;
  updatedAt: string;
  objective: string;
  outcomeJsonPath: string;
  outcomeMarkdownPath: string;
};

export type ValidationReport = {
  schemaVersion: 1;
  runId: string;
  status: OutcomeStatus;
  validation: ValidationResult[];
};
