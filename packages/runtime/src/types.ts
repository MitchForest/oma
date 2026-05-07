export type Objective = {
  goal: string;
  constraints: string[];
  success: string[];
};

export type OutcomeStatus =
  | "succeeded"
  | "failed"
  | "partial"
  | "blocked"
  | "expired"
  | "inconclusive";

export type RunStatus = "running" | OutcomeStatus;

export type ArtifactKind = "report" | "patch" | "log" | "directory" | "custom";

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  content: string;
};

export type TextEvidence = {
  kind: "text";
  message: string;
};

export type CommandEvidence = {
  kind: "command";
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
};

export type ArtifactEvidence = {
  kind: "artifact";
  name: string;
  message: string;
  artifactId?: string;
};

export type Evidence = TextEvidence | CommandEvidence | ArtifactEvidence;

export type ValidationStatus = "passed" | "failed" | "inconclusive";

export type ValidationResult = {
  validatorId: string;
  status: ValidationStatus;
  evidence: Evidence[];
};

export type EnvironmentCapabilities = {
  shell?: boolean;
  filesystem?: boolean;
  git?: boolean;
  securityBoundary: false | "process" | "container" | "remote";
};

export type EnvironmentContext = {
  runId: string;
  session: Session;
};

export type CommandObserver = {
  stderr?(chunk: string): void | Promise<void>;
  stdout?(chunk: string): void | Promise<void>;
};

export type CommandInput = {
  command: string;
  args?: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
};

export type ShellCapability = {
  exec(input: CommandInput, observer?: CommandObserver): Promise<CommandResult>;
};

export type FilesystemCapability = {
  list(path: string): Promise<Array<{ path: string; bytes: number }>>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
};

export type GitStatusResult = {
  clean: boolean;
  short: string;
};

export type GitCapability = {
  diff(): Promise<string>;
  status(): Promise<GitStatusResult>;
};

export type BaseEvent<TType extends string, TData extends Record<string, unknown>> = {
  schemaVersion: number;
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
  type: TType;
  at: string;
  data: TData;
};

export type RunStartedEvent = BaseEvent<
  "run.started",
  {
    objective: Objective;
  }
>;

export type HarnessStartedEvent = BaseEvent<"harness.started", Record<string, never>>;

export type HarnessCompletedEvent = BaseEvent<
  "harness.completed",
  {
    artifactCount: number;
  }
>;

export type HarnessObservationKind = "message" | "tool" | "usage" | "state";

export type HarnessObservationStatus = "started" | "updated" | "completed" | "failed";

export type HarnessObservationInput = {
  kind: HarnessObservationKind;
  label?: string;
  status?: HarnessObservationStatus;
  summary?: string;
};

export type HarnessObservedEvent = BaseEvent<
  "harness.observed",
  {
    harnessId: string;
    kind: HarnessObservationKind;
    label?: string;
    status?: HarnessObservationStatus;
    summary?: string;
  }
>;

export type ArtifactProducedEvent = BaseEvent<
  "artifact.produced",
  {
    artifact: Artifact;
  }
>;

export type ValidationStartedEvent = BaseEvent<
  "validation.started",
  {
    validatorId: string;
  }
>;

export type ValidationCompletedEvent = BaseEvent<
  "validation.completed",
  {
    result: ValidationResult;
  }
>;

export type RunCompletedEvent = BaseEvent<
  "run.completed",
  {
    status: OutcomeStatus;
  }
>;

export type RunFailedEvent = BaseEvent<
  "run.failed",
  {
    status: "blocked" | "failed";
    message: string;
  }
>;

export type EnvironmentCommandStartedEvent = BaseEvent<
  "environment.command.started",
  {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }
>;

export type EnvironmentCommandOutputEvent = BaseEvent<
  "environment.command.output",
  {
    command: string;
    stream: "stdout" | "stderr";
    text: string;
    truncated: boolean;
  }
>;

export type EnvironmentCommandExitedEvent = BaseEvent<
  "environment.command.exited",
  {
    command: string;
    exitCode: number | null;
    durationMs: number;
  }
>;

export type EnvironmentCommandTimedOutEvent = BaseEvent<
  "environment.command.timed_out",
  {
    command: string;
    durationMs: number;
    timeoutMs: number;
  }
>;

export type EnvironmentCommandFailedEvent = BaseEvent<
  "environment.command.failed",
  {
    command: string;
    message: string;
    durationMs: number;
  }
>;

export type EnvironmentFilesystemReadEvent = BaseEvent<
  "environment.filesystem.read",
  {
    path: string;
    bytes: number;
  }
>;

export type EnvironmentFilesystemWroteEvent = BaseEvent<
  "environment.filesystem.wrote",
  {
    path: string;
    bytes: number;
  }
>;

export type EnvironmentGitStatusEvent = BaseEvent<
  "environment.git.status",
  {
    clean: boolean;
    short: string;
  }
>;

export type Event =
  | RunStartedEvent
  | HarnessStartedEvent
  | HarnessCompletedEvent
  | HarnessObservedEvent
  | ArtifactProducedEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | EnvironmentCommandStartedEvent
  | EnvironmentCommandOutputEvent
  | EnvironmentCommandExitedEvent
  | EnvironmentCommandTimedOutEvent
  | EnvironmentCommandFailedEvent
  | EnvironmentFilesystemReadEvent
  | EnvironmentFilesystemWroteEvent
  | EnvironmentGitStatusEvent;

export type UnknownEvent = BaseEvent<string, Record<string, unknown>>;

export type StoredEvent = Event | UnknownEvent;

export type AppendEventInput<TEvent extends Event = Event> = Omit<
  TEvent,
  "id" | "schemaVersion" | "sequence" | "sessionId"
>;

export type Session = {
  id: string;
  append<TEvent extends Event>(event: AppendEventInput<TEvent>): Promise<TEvent>;
  events(): Promise<StoredEvent[]>;
};

export type RestorableSession = Session & {
  restore(events: StoredEvent[]): Promise<void>;
};

export type SessionSummary = {
  id: string;
  createdAt: string;
};

export type SessionStore = {
  create(input?: { id?: string }): Promise<Session>;
  open(id: string): Promise<Session>;
  list?(): Promise<SessionSummary[]>;
};

export type Environment = {
  kind: string;
  capabilities: EnvironmentCapabilities;
  bind(context: EnvironmentContext): BoundEnvironment;
};

export type BoundEnvironment = {
  kind: string;
  capabilities: EnvironmentCapabilities;
  shell?: ShellCapability;
  filesystem?: FilesystemCapability;
  git?: GitCapability;
};

export type HarnessResult = {
  artifacts: Artifact[];
};

export type ArtifactCollectorInput = {
  environment: BoundEnvironment;
};

export type ArtifactCollector = {
  id: string;
  collect(input: ArtifactCollectorInput): Promise<Artifact>;
};

export type HarnessInput = {
  runId: string;
  objective: Objective;
  environment: BoundEnvironment;
  session: Session;
  observe(input: HarnessObservationInput): Promise<HarnessObservedEvent>;
};

export type Harness = {
  id?: string;
  run(input: HarnessInput): Promise<HarnessResult>;
};

export type ValidatorInput = {
  objective: Objective;
  artifacts: Artifact[];
  environment: BoundEnvironment;
  session: Session;
};

export type Validator = {
  id: string;
  validate(input: ValidatorInput): Promise<ValidationResult>;
};

export type Outcome = {
  runId: string;
  status: OutcomeStatus;
  objective: Objective;
  artifacts: Artifact[];
  validation: ValidationResult[];
  events: StoredEvent[];
};

export type RunInput = {
  objective: Objective;
  process: {
    session: Session;
    harness: Harness;
  };
  environment: Environment;
  validation?: Validator[];
};

export type RunStopPoint = "run.started" | "harness.started" | "artifacts.produced";

export type RunOptions = {
  runId?: string;
  stopAfter?: RunStopPoint;
};

export type SessionDiagnosticCode =
  | "unknown_event_type"
  | "invalid_event_data"
  | "sequence_gap"
  | "schema_version_unsupported"
  | "not_terminal"
  | "missing_objective";

export type SessionDiagnostic = {
  code: SessionDiagnosticCode;
  message: string;
  sequence?: number;
};

export type RunProjection = {
  sessionId: string;
  runId?: string;
  status: "not_started" | "running" | OutcomeStatus;
  objective?: Objective;
  harnessStarted: boolean;
  harnessCompleted: boolean;
  artifacts: Artifact[];
  validation: ValidationResult[];
  events: StoredEvent[];
  diagnostics: SessionDiagnostic[];
};

export type ReplayOutcomeResult =
  | {
      ok: true;
      outcome: Outcome;
    }
  | {
      ok: false;
      reason: "not_terminal" | "invalid_session";
      diagnostics: SessionDiagnostic[];
      projection: RunProjection;
    };

export type ResumeInput = Omit<RunInput, "process"> & {
  process: {
    session: Session;
    harness: Harness;
  };
};

export type OutcomeJsonV1 = {
  schemaVersion: 1;
  runId: string;
  status: OutcomeStatus;
  objective: Objective;
  artifacts: Array<{
    id: string;
    kind: ArtifactKind;
    name: string;
    mediaType: string;
    size: number;
  }>;
  validation: ValidationResult[];
  eventCount: number;
};
