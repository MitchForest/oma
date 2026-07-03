import { z } from "zod";

export const eventIdSchema = z.string().min(1);
export const sessionIdSchema = z.string().min(1);

export const eventEnvelopeSchema = z.object({
  id: eventIdSchema,
  sessionId: sessionIdSchema,
  offset: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});

export const sessionStartedEventSchema = z.object({
  type: z.literal("session.started"),
  profileName: z.string().min(1).optional(),
  mode: z.enum(["interactive", "automation", "job"]).optional()
});

export const sessionForkedEventSchema = z.object({
  type: z.literal("session.forked"),
  fromSessionId: sessionIdSchema,
  atOffset: z.number().int().nonnegative()
});

export const userMessageEventSchema = z.object({
  type: z.literal("message.user"),
  content: z.string()
});

export const assistantMessageEventSchema = z.object({
  type: z.literal("message.assistant"),
  content: z.string()
});

export const triggerReceivedEventSchema = z.object({
  type: z.literal("trigger.received"),
  source: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
  deliveryId: z.string().min(1).optional(),
  receivedAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const runStartedEventSchema = z.object({
  type: z.literal("run.started"),
  runId: z.string().min(1)
});

export const runCompletedEventSchema = z.object({
  type: z.literal("run.completed"),
  runId: z.string().min(1),
  steps: z.number().int().nonnegative()
});

export const runPausedEventSchema = z.object({
  type: z.literal("run.paused"),
  runId: z.string().min(1),
  steps: z.number().int().nonnegative(),
  reason: z.string().min(1)
});

export const runFailedEventSchema = z.object({
  type: z.literal("run.failed"),
  runId: z.string().min(1),
  error: z.object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional()
  })
});

export const toolCallEventSchema = z.object({
  type: z.literal("tool.call"),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown(),
  providerCallId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional()
});

export const toolResultEventSchema = z.object({
  type: z.literal("tool.result"),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  result: z.unknown(),
  metadata: z.record(z.unknown()).optional()
});

export const toolErrorEventSchema = z.object({
  type: z.literal("tool.error"),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  error: z.object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional()
  }),
  retryable: z.boolean().optional()
});

export const modelRequestEventSchema = z.object({
  type: z.literal("model.request"),
  provider: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const modelResponseEventSchema = z.object({
  type: z.literal("model.response"),
  turn: z.unknown(),
  action: z.unknown().optional()
});

export const modelErrorEventSchema = z.object({
  type: z.literal("model.error"),
  error: z.object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional()
  })
});

export const sandboxProvisionedEventSchema = z.object({
  type: z.literal("sandbox.provisioned"),
  sandboxId: z.string().min(1),
  kind: z.string().min(1),
  metadata: z.record(z.unknown()).optional()
});

export const sandboxExecStartedEventSchema = z.object({
  type: z.literal("sandbox.exec.started"),
  sandboxId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional()
});

export const sandboxExecCompletedEventSchema = z.object({
  type: z.literal("sandbox.exec.completed"),
  sandboxId: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative().optional()
});

export const sandboxExecFailedEventSchema = z.object({
  type: z.literal("sandbox.exec.failed"),
  sandboxId: z.string().min(1),
  command: z.string().min(1),
  error: z.object({
    name: z.string().optional(),
    message: z.string(),
    stack: z.string().optional()
  }),
  durationMs: z.number().nonnegative().optional()
});

export const sandboxDestroyedEventSchema = z.object({
  type: z.literal("sandbox.destroyed"),
  sandboxId: z.string().min(1),
  kind: z.string().min(1),
  metadata: z.record(z.unknown()).optional()
});

export const systemNoteEventSchema = z.object({
  type: z.literal("system.note"),
  message: z.string()
});

export const workflowLoadedEventSchema = z.object({
  type: z.literal("workflow.loaded"),
  name: z.string().min(1),
  title: z.string().min(1).optional(),
  sourcePath: z.string().min(1).optional(),
  // sha256 of the workflow source text: the log records exactly which version
  // of the workflow created this session.
  sourceHash: z.string().min(1)
});

export const workflowRunStartedEventSchema = z.object({
  type: z.literal("workflow.run.started"),
  name: z.string().min(1),
  sourceHash: z.string().min(1),
  trigger: z
    .object({
      source: z.string().min(1),
      kind: z.string().min(1)
    })
    .optional(),
  inputs: z.record(z.unknown()).optional()
});

export const workflowRunCompletedEventSchema = z.object({
  type: z.literal("workflow.run.completed"),
  name: z.string().min(1),
  sourceHash: z.string().min(1),
  status: z.enum(["completed", "failed", "denied", "max-iterations"]),
  reason: z.string().optional()
});

export const workflowStageStartedEventSchema = z.object({
  type: z.literal("workflow.stage.started"),
  stage: z.string().min(1),
  iteration: z.number().int().positive(),
  // The stage's own durable session; its full transcript lives there.
  sessionId: sessionIdSchema
});

// The stage belongs to a different placement (`runs_on`): orchestration
// pauses here and whichever worker matches resumes the same log.
export const workflowStageDispatchedEventSchema = z.object({
  type: z.literal("workflow.stage.dispatched"),
  stage: z.string().min(1),
  iteration: z.number().int().positive(),
  runsOn: z.string().min(1)
});

export const workflowStageCompletedEventSchema = z.object({
  type: z.literal("workflow.stage.completed"),
  stage: z.string().min(1),
  iteration: z.number().int().positive(),
  sessionId: sessionIdSchema,
  status: z.enum(["completed", "failed"]),
  output: z.record(z.unknown()).optional(),
  reason: z.string().optional()
});

// Approvals gate two things: workflow stages (stage/iteration set) and
// individual effectful tool calls (callId/toolName set).
export const humanApprovalRequestedEventSchema = z.object({
  type: z.literal("human.approval.requested"),
  stage: z.string().min(1).optional(),
  iteration: z.number().int().positive().optional(),
  callId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  summary: z.string().optional()
});

export const humanApprovalGrantedEventSchema = z.object({
  type: z.literal("human.approval.granted"),
  stage: z.string().min(1).optional(),
  iteration: z.number().int().positive().optional(),
  callId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  note: z.string().optional()
});

// The durable record of exactly what file context a model was shown and why
// it fit the budget: every included file with hash and mode, every demotion
// and drop with its reason. Appended before the message that carried the pack.
export const contextPackBuiltEventSchema = z.object({
  type: z.literal("context.pack.built"),
  packId: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      hash: z.string().min(1),
      /** full = whole file body; map = signature-level codemap only. */
      mode: z.enum(["full", "map"]),
      tokens: z.number().int().nonnegative(),
      /** Set when the fitter changed this file's mode to stay in budget. */
      demoted: z.boolean().optional()
    })
  ),
  dropped: z
    .array(
      z.object({
        path: z.string().min(1),
        tokens: z.number().int().nonnegative(),
        reason: z.string().min(1)
      })
    )
    .optional(),
  /** Token estimates use a chars/4 heuristic, not a provider tokenizer. */
  totalTokens: z.number().int().nonnegative(),
  budget: z.number().int().positive().optional()
});

export const humanApprovalDeniedEventSchema = z.object({
  type: z.literal("human.approval.denied"),
  stage: z.string().min(1).optional(),
  iteration: z.number().int().positive().optional(),
  callId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  reason: z.string().optional()
});

export const eventPayloadSchema = z.discriminatedUnion("type", [
  sessionStartedEventSchema,
  sessionForkedEventSchema,
  userMessageEventSchema,
  assistantMessageEventSchema,
  triggerReceivedEventSchema,
  runStartedEventSchema,
  runCompletedEventSchema,
  runPausedEventSchema,
  runFailedEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  toolErrorEventSchema,
  modelRequestEventSchema,
  modelResponseEventSchema,
  modelErrorEventSchema,
  sandboxProvisionedEventSchema,
  sandboxExecStartedEventSchema,
  sandboxExecCompletedEventSchema,
  sandboxExecFailedEventSchema,
  sandboxDestroyedEventSchema,
  systemNoteEventSchema,
  workflowLoadedEventSchema,
  workflowRunStartedEventSchema,
  workflowRunCompletedEventSchema,
  workflowStageStartedEventSchema,
  workflowStageDispatchedEventSchema,
  workflowStageCompletedEventSchema,
  humanApprovalRequestedEventSchema,
  humanApprovalGrantedEventSchema,
  humanApprovalDeniedEventSchema,
  contextPackBuiltEventSchema
]);

export const sessionEventSchema = eventEnvelopeSchema.and(eventPayloadSchema);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type EventPayload = z.infer<typeof eventPayloadSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type NewSessionEvent = EventPayload;
export type ToolCallEvent = z.infer<typeof eventEnvelopeSchema> &
  z.infer<typeof toolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof eventEnvelopeSchema> &
  z.infer<typeof toolResultEventSchema>;
export type ToolErrorEvent = z.infer<typeof eventEnvelopeSchema> &
  z.infer<typeof toolErrorEventSchema>;

export function createEventId(): string {
  return crypto.randomUUID();
}

export function createTimestamp(): string {
  return new Date().toISOString();
}

const maxRecordedStackBytes = 4_000;

export function errorToRecord(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      // Stacks land in the durable log; cap them so one deep failure cannot
      // bloat the session record.
      stack: error.stack?.slice(0, maxRecordedStackBytes)
    };
  }

  return { message: String(error) };
}
