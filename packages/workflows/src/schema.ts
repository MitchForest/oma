import { z } from "zod";
import { effectRuleSchema } from "@oma/core";
import { parseUntilCondition } from "./conditions";
import { isDuration, isTokenCount } from "./units";

const triggerPatternSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const separator = value.indexOf(":");
      return separator > 0 && separator < value.length - 1;
    },
    { message: 'trigger patterns must use "source:kind" syntax, e.g. "github:pull_request.opened"' }
  );

export const workflowTriggerSchema = z
  .object({
    on: triggerPatternSchema,
    also: z.array(triggerPatternSchema).default([]),
    // Equality match against the signal: keys are dot paths (`payload.action`),
    // values compare strictly. All entries must match for the signal to route.
    filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    session: z.string().min(1).optional()
  })
  .strict();

export const workflowSandboxSchema = z.union([
  z.enum(["local", "worktree", "docker"]),
  z
    .object({
      kind: z.enum(["local", "worktree", "docker"])
    })
    .catchall(z.unknown())
]);

/**
 * The agent doing the work, defined inline — the workflow file is the whole
 * product. A stage's agent, when present, is complete: it replaces the
 * workflow default rather than merging with it (partial reuse is what
 * `use:`/`extends:` are for).
 */
export const workflowAgentSchema = z
  .object({
    /** The system prompt. */
    prompt: z.string().min(1),
    /** Markdown files appended to the prompt (workflow-dir-relative, then cwd). */
    instructions: z.array(z.string().min(1)).default([]),
    tools: z.array(z.string().min(1)).default([]),
    sandbox: workflowSandboxSchema.default("local"),
    /**
     * Model for this agent: a name on the configured provider, or
     * `module://<pkg>#<export>` loading a provider factory (code execution —
     * the same trust level as `run:` code workflows).
     */
    model: z.string().min(1).optional()
  })
  .strict();

export const workflowInputSchema = z
  .object({
    description: z.string().optional(),
    required: z.boolean().default(false),
    default: z.string().optional()
  })
  .strict();

export const workflowBudgetSchema = z
  .object({
    tokens: z
      .union([
        z.number().int().positive(),
        z.string().refine(isTokenCount, 'tokens must be a number, "500k", or "2M"')
      ])
      .optional(),
    wall: z
      .string()
      .refine(isDuration, 'wall must be a duration like "45s", "30m", or "2h"')
      .optional()
  })
  .strict();

export const workflowPolicySchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    /** What a tool failure does to the run (default continue — right for automations). */
    onToolError: z.enum(["continue", "fail"]).optional(),
    /** Tool-name patterns -> allow | approve | deny (or {decision, max, dedupe}). */
    effects: z.record(effectRuleSchema).optional(),
    /** Hard stops: the run pauses resumably before exceeding them. */
    budget: workflowBudgetSchema.optional()
  })
  .strict();

const secretRefPattern = /^[a-z][a-z0-9+.-]*:\/\/.+$/i;

export const workflowEnvSchema = z
  .object({
    /** Name -> reference (env://VAR, file:///path, keychain://service/account). Values resolve harness-side and never enter the log or model context. */
    secrets: z
      .record(
        z
          .string()
          .regex(
            secretRefPattern,
            "secret refs look like env://VAR, file:///path, or keychain://service/account"
          )
      )
      .default({}),
    /** Secret names additionally injected into the sandbox environment. */
    expose: z.array(z.string().min(1)).default([])
  })
  .strict();

// Output field specs: "string" | "number" | "boolean" | an enum written as
// "approve | revise". Every declared field is required in the stage's output.
export const outputFieldPattern = /^(string|number|boolean|[\w-]+(\s*\|\s*[\w-]+)+)$/;

export const workflowOutputSchema = z.record(
  z
    .string()
    .min(1)
    .regex(
      outputFieldPattern,
      'output fields must be "string", "number", "boolean", or an enum like "approve | revise"'
    )
);

export const workflowContextSchema = z
  .object({
    /** Glob patterns of files to show the model (sorted, deterministic). */
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).default([]),
    /**
     * Globs rendered as signature-level codemaps instead of full bodies
     * (~5-10% of the token cost). Over-budget full files demote to map
     * before anything is dropped.
     */
    map: z.array(z.string().min(1)).default([]),
    /** Hard ceiling for the pack, e.g. "120k" (chars/4 token estimate). */
    budget: z
      .union([
        z.number().int().positive(),
        z.string().refine(isTokenCount, 'budget must be a number, "500k", or "2M"')
      ])
      .optional()
  })
  .strict();

export const workflowStageSchema = z
  .object({
    /**
     * Pull shared fields from a stage library: `use: "stages/common.yml#judge"`
     * loads that entry, and any fields declared locally override it. Resolved
     * by the loader before validation.
     */
    use: z.string().min(1).optional(),
    /** This stage's agent; omitted means the workflow's default agent. */
    agent: workflowAgentSchema.optional(),
    /**
     * Placement: `local` (the interactive CLI) or `worker:<name>` (a machine
     * running `oma worker --name <name>` against the same store). Omitted
     * means the stage runs wherever the orchestration is currently resumed.
     */
    runs_on: z
      .string()
      .regex(
        /^(local|worker:[A-Za-z0-9_.-]+)$/,
        'runs_on must be "local" or "worker:<name>"'
      )
      .optional(),
    prompt: z.string().min(1),
    // Sent instead of `prompt` when the stage re-runs in a later loop
    // iteration; may reference outputs that do not exist on iteration one.
    reprompt: z.string().min(1).optional(),
    approve: z.boolean().default(false),
    output: workflowOutputSchema.optional(),
    /** Per-stage context override; defaults to the workflow's context block. */
    context: workflowContextSchema.optional()
  })
  .strict();

export const workflowLoopSchema = z
  .object({
    over: z.array(z.string().min(1)).min(1),
    until: z.string().min(1),
    max: z.number().int().positive().default(5)
  })
  .strict();

// Strict everywhere: a workflow is an unattended automation, so an ignored
// typo (`fitler`, `sesion`) is a silent behavior change. Unknown fields are
// rejected with the offending key named and a nearest-field hint.
// The bare object schema exists so field lists stay introspectable
// (`.shape`) after superRefine wraps the exported schema in ZodEffects.
export const workflowObjectSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9][a-z0-9._-]*$/,
        "name must be lowercase letters, digits, dots, underscores, or dashes"
      ),
    /**
     * Inherit from a base workflow file. Merge rules: scalars and arrays are
     * replaced by the child; object maps (stages, inputs, policy.effects,
     * env.secrets, trigger, context) merge per key with child winning; stage
     * entries merge field-by-field. Resolved by the loader before validation.
     */
    extends: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    trigger: workflowTriggerSchema.optional(),
    prompt: z.string().min(1).optional(),
    /** The default agent; required unless every stage declares its own. */
    agent: workflowAgentSchema.optional(),
    stages: z.record(workflowStageSchema).optional(),
    loop: workflowLoopSchema.optional(),
    /** Path to a code workflow module — the escape hatch for coordination YAML can't say. */
    run: z.string().min(1).optional(),
    inputs: z.record(workflowInputSchema).default({}),
    policy: workflowPolicySchema.default({}),
    env: workflowEnvSchema.optional(),
    /** Files the model is shown, with budgets — see workflowContextSchema. */
    context: workflowContextSchema.optional()
  })
  .strict();

export const workflowDataSchema = workflowObjectSchema.superRefine((workflow, context) => {
    for (const name of workflow.env?.expose ?? []) {
      if (!workflow.env?.secrets[name]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["env", "expose"],
          message: `env.expose references undeclared secret "${name}"`
        });
      }
    }

    if (workflow.stages && Object.keys(workflow.stages).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "stages must declare at least one stage"
      });
      return;
    }

    const agents: Array<[string[], z.infer<typeof workflowAgentSchema> | undefined]> = [
      [["agent"], workflow.agent],
      ...Object.entries(workflow.stages ?? {}).map(
        ([stageName, stage]): [string[], z.infer<typeof workflowAgentSchema> | undefined] => [
          ["stages", stageName, "agent"],
          stage.agent
        ]
      )
    ];

    for (const [path, agent] of agents) {
      const sandbox = agent?.sandbox;

      if (
        sandbox &&
        typeof sandbox === "object" &&
        sandbox.kind === "docker" &&
        typeof (sandbox as Record<string, unknown>).image !== "string"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "sandbox"],
          message: "docker sandboxes require an image"
        });
      }
    }

    if (!workflow.stages) {
      if (!workflow.prompt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "a workflow needs either a top-level prompt or stages"
        });
      }

      if (!workflow.agent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agent"],
          message: "a single-stage workflow needs a top-level agent"
        });
      }

      for (const field of ["loop", "run"] as const) {
        if (workflow[field] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} requires stages`
          });
        }
      }

      return;
    }

    if (workflow.prompt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "top-level prompt and stages are mutually exclusive; each stage has its own prompt"
      });
    }

    if (!workflow.agent) {
      for (const [stageName, stage] of Object.entries(workflow.stages)) {
        if (!stage.agent) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", stageName, "agent"],
            message: `stage "${stageName}" needs an agent (or declare a workflow-level default)`
          });
        }
      }
    }

    if (workflow.run && workflow.loop) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["run"],
        message: "run and loop are mutually exclusive; the code workflow owns its own loop"
      });
    }

    if (workflow.loop) {
      validateLoop(workflow.loop, workflow.stages, context);
    }
  });

function validateLoop(
  loop: z.infer<typeof workflowLoopSchema>,
  stages: Record<string, z.infer<typeof workflowStageSchema>>,
  context: z.RefinementCtx
): void {
  const order = Object.keys(stages);

  for (const name of loop.over) {
    if (!stages[name]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loop", "over"],
        message: `loop.over references undeclared stage "${name}"`
      });
      return;
    }
  }

  const start = order.indexOf(loop.over[0]!);
  const contiguous = loop.over.every((name, index) => order[start + index] === name);

  if (!contiguous) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loop", "over"],
      message: "loop.over must be a contiguous run of stages in declaration order"
    });
  }

  const condition = parseUntilCondition(loop.until);

  if (!condition) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loop", "until"],
      message: 'loop.until must look like "<stage>.<field> == literal" (or !=)'
    });
    return;
  }

  if (!loop.over.includes(condition.stage)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loop", "until"],
      message: `loop.until must test a stage inside loop.over, got "${condition.stage}"`
    });
    return;
  }

  const output = stages[condition.stage]?.output;

  if (!output?.[condition.field]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["loop", "until"],
      message: `loop.until references "${condition.stage}.${condition.field}", but that stage does not declare it under output`
    });
  }
}

export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;
export type WorkflowOutputSpec = z.infer<typeof workflowOutputSchema>;
export type WorkflowStage = z.infer<typeof workflowStageSchema>;
export type WorkflowLoop = z.infer<typeof workflowLoopSchema>;
export type WorkflowBudget = z.infer<typeof workflowBudgetSchema>;
export type WorkflowEnv = z.infer<typeof workflowEnvSchema>;
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
export type WorkflowData = z.infer<typeof workflowDataSchema>;
