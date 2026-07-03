import { z } from "zod";
import type { SandboxPolicy } from "../sandbox/sandbox";
import type { Tool } from "../tools/tool";
import type { TriggerSignal } from "../triggers/trigger";

export const profileModeSchema = z.enum(["interactive", "automation", "job"]);
export const toolErrorPolicySchema = z.enum(["fail", "continue"]);

export const effectDecisionSchema = z.enum(["allow", "approve", "deny"]);

export const effectRuleSchema = z.union([
  effectDecisionSchema,
  z
    .object({
      decision: effectDecisionSchema.optional(),
      max: z.number().int().positive().optional(),
      dedupe: z.boolean().optional(),
      reason: z.string().optional()
    })
    .strict()
]);

export const profilePolicySchema = z
  .object({
    toolError: toolErrorPolicySchema.default("fail"),
    maxSteps: z.number().int().positive().optional(),
    /** Tool-name patterns -> allow/approve/deny rules, enforced by the harness. */
    effects: z.record(effectRuleSchema).optional()
  })
  .catchall(z.unknown());

// Strict at the top level so typos (`skils`, `maxStep`) are rejected with the
// offending key named. `policy` and `sandboxPolicy` keep their catchalls — they
// are deliberate extension points.
export const profileDataSchema = z
  .object({
    name: z.string().min(1),
    mode: profileModeSchema,
    systemPrompt: z.string(),
    skills: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    sandboxPolicy: z
      .object({
        kind: z.string().min(1),
        cwd: z.string().optional()
      })
      .catchall(z.unknown()),
    modelDefaults: z.record(z.unknown()).default({}),
    policy: profilePolicySchema.default({ toolError: "fail" }),
    sessionKey: z.string().min(1).optional()
  })
  .strict();

export type ProfileMode = z.infer<typeof profileModeSchema>;
export type ToolErrorPolicy = z.infer<typeof toolErrorPolicySchema>;
export type ProfilePolicy = z.infer<typeof profilePolicySchema>;
export type ProfileData = z.infer<typeof profileDataSchema>;

export type SessionKeyResolver =
  | string
  | ((signal: TriggerSignal) => string | Promise<string>);

export interface ProfileInput
  extends Omit<ProfileData, "policy" | "sessionKey"> {
  policy?: Record<string, unknown>;
  toolImplementations?: Tool[];
  sandboxPolicy: SandboxPolicy;
  sessionKey?: SessionKeyResolver;
}

export interface Profile extends Omit<ProfileData, "sessionKey"> {
  toolImplementations?: Tool[];
  sandboxPolicy: SandboxPolicy;
  policy: ProfilePolicy;
  sessionKey?: SessionKeyResolver;
}

export function defineProfile(profile: ProfileInput): Profile {
  return validateProfile(profile);
}

export function validateProfile(profile: ProfileInput): Profile {
  // Runtime-only keys are not part of the declarative schema: tool
  // implementations are live objects and sessionKey may be a resolver
  // function. Strip them before strict parsing and re-attach them explicitly
  // below — unknown keys must not survive validation via a blind spread.
  const { toolImplementations, sessionKey, ...data } = profile;
  const parsed = profileDataSchema.parse({
    ...data,
    sessionKey: typeof sessionKey === "string" ? sessionKey : undefined
  });

  return {
    name: parsed.name,
    mode: parsed.mode,
    systemPrompt: parsed.systemPrompt,
    skills: parsed.skills,
    tools: parsed.tools,
    sandboxPolicy: parsed.sandboxPolicy as SandboxPolicy,
    modelDefaults: parsed.modelDefaults,
    policy: parsed.policy,
    ...(toolImplementations !== undefined ? { toolImplementations } : {}),
    ...(sessionKey !== undefined ? { sessionKey } : {})
  };
}

export async function resolveSessionKey(
  resolver: SessionKeyResolver | undefined,
  signal: TriggerSignal,
  // Wrapped in a closure: the bare method reference `crypto.randomUUID`
  // loses its `this` binding and throws "Expected this to be instanceof
  // Crypto" when invoked as a plain function.
  fallback: () => string = () => crypto.randomUUID()
): Promise<string> {
  if (!resolver) {
    return fallback();
  }

  if (typeof resolver === "function") {
    return assertSessionKey(await resolver(signal));
  }

  return assertSessionKey(interpolateSessionKey(resolver, signal));
}

export function interpolateSessionKey(template: string, signal: TriggerSignal): string {
  return template.replace(/\{([^}]+)\}/g, (_match, path: string) => {
    const value = readSignalPath(signal, path.trim());

    if (value === undefined || value === null) {
      throw new Error(`Unable to resolve sessionKey field: ${path}`);
    }

    return String(value);
  });
}

function readSignalPath(signal: TriggerSignal, path: string): unknown {
  const root = { ...signal, payload: signal.payload } as Record<string, unknown>;
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[part];
  }, root);
}

function assertSessionKey(value: string): string {
  if (!value) {
    throw new Error("Resolved sessionKey must not be empty");
  }

  return value;
}
