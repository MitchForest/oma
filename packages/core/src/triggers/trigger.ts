import { spawn } from "../entities/entities";
import type { HarnessRuntime, WakeOptions } from "../harness/harness";
import { wake } from "../harness/harness";
import type { Profile } from "../profiles/profile";
import { resolveSessionKey } from "../profiles/profile";
import type { NewSessionEvent } from "../session/events";

export interface TriggerSignal {
  source: string;
  kind: string;
  payload: unknown;
  deliveryId?: string;
  receivedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface TriggerDefinition {
  on: string;
  profile: Profile;
  filter?: (signal: TriggerSignal) => boolean | Promise<boolean>;
  prompt: string | ((signal: TriggerSignal) => string | Promise<string>);
}

export interface TriggerSubscription {
  close(): Promise<void>;
}

export interface TriggerAdapter {
  name: string;
  start(dispatch: (signal: TriggerSignal) => Promise<void>): Promise<TriggerSubscription>;
}

export type TriggerRouteResult =
  | { type: "ignored" }
  | { type: "filtered" }
  | { type: "spawned"; sessionId: string }
  | { type: "woken"; sessionId: string };

export interface TriggerRouteOptions extends WakeOptions {
  /** Append routing events without executing the harness. Useful for dry runs. */
  noWake?: boolean;
  fallbackSessionId?: () => string;
  /**
   * Extra events appended once, immediately after the session is spawned and
   * before the trigger/message events (e.g. `workflow.loaded`).
   */
  spawnEvents?: NewSessionEvent[];
  /**
   * Extra events appended on every routed signal, before the trigger/message
   * events (e.g. `workflow.run.started`).
   */
  signalEvents?: NewSessionEvent[];
  /**
   * Extra session metadata recorded at spawn (e.g. `profilePath` so later
   * wakes can reload the same profile).
   */
  sessionMetadata?: Record<string, unknown>;
}

export function defineTrigger(trigger: TriggerDefinition): TriggerDefinition {
  return trigger;
}

export function matchesTrigger(trigger: TriggerDefinition, signal: TriggerSignal): boolean {
  const [source, kindPattern] = splitTriggerPattern(trigger.on);

  if (source !== signal.source) {
    return false;
  }

  if (kindPattern === "*" || kindPattern === signal.kind) {
    return true;
  }

  if (kindPattern.endsWith(".*")) {
    return signal.kind.startsWith(kindPattern.slice(0, -1));
  }

  return false;
}

export async function routeTriggerSignal(
  runtime: HarnessRuntime,
  trigger: TriggerDefinition,
  signal: TriggerSignal,
  options: TriggerRouteOptions = {}
): Promise<TriggerRouteResult> {
  if (!matchesTrigger(trigger, signal)) {
    return { type: "ignored" };
  }

  if (trigger.filter && !(await trigger.filter(signal))) {
    return { type: "filtered" };
  }

  const sessionId = await resolveSessionKey(
    trigger.profile.sessionKey,
    signal,
    options.fallbackSessionId
  );

  if (runtime.wakeLock) {
    return runtime.wakeLock.withSessionLock(sessionId, () =>
      routeTriggerSignalUnlocked({ ...runtime, wakeLock: undefined }, trigger, signal, sessionId, options)
    );
  }

  return routeTriggerSignalUnlocked(runtime, trigger, signal, sessionId, options);
}

async function routeTriggerSignalUnlocked(
  runtime: HarnessRuntime,
  trigger: TriggerDefinition,
  signal: TriggerSignal,
  sessionId: string,
  options: TriggerRouteOptions
): Promise<TriggerRouteResult> {
  const prompt = await resolvePrompt(trigger, signal);
  const exists = await runtime.store.exists(sessionId);

  if (!exists) {
    await spawn(runtime.store, trigger.profile, {
      id: sessionId,
      metadata: {
        ...options.sessionMetadata,
        trigger: trigger.on
      }
    });
    for (const event of [...(options.spawnEvents ?? []), ...(options.signalEvents ?? [])]) {
      await runtime.store.appendEvent(sessionId, event);
    }
    await runtime.store.appendEvent(sessionId, {
      ...triggerReceivedEvent(signal)
    });
    await runtime.store.appendEvent(sessionId, {
      type: "message.user",
      content: prompt
    });
    if (!options.noWake) {
      await wake(runtime, sessionId, trigger.profile, options);
    }
    return { type: "spawned", sessionId };
  }

  for (const event of options.signalEvents ?? []) {
    await runtime.store.appendEvent(sessionId, event);
  }
  await runtime.store.appendEvent(sessionId, {
    ...triggerReceivedEvent(signal)
  });
  await runtime.store.appendEvent(sessionId, {
    type: "message.user",
    content: prompt
  });
  if (!options.noWake) {
    await wake(runtime, sessionId, trigger.profile, options);
  }
  return { type: "woken", sessionId };
}

function triggerReceivedEvent(signal: TriggerSignal) {
  return {
    type: "trigger.received" as const,
    source: signal.source,
    kind: signal.kind,
    payload: signal.payload,
    deliveryId: signal.deliveryId,
    receivedAt: signal.receivedAt,
    metadata: signal.metadata
  };
}

function splitTriggerPattern(on: string): [string, string] {
  const separator = on.indexOf(":");

  if (separator === -1) {
    throw new Error(`Trigger "on" must use source:kind syntax: ${on}`);
  }

  const source = on.slice(0, separator);
  const kind = on.slice(separator + 1);

  if (!source || !kind) {
    throw new Error(`Trigger "on" must use source:kind syntax: ${on}`);
  }

  return [source, kind];
}

async function resolvePrompt(
  trigger: TriggerDefinition,
  signal: TriggerSignal
): Promise<string> {
  if (typeof trigger.prompt === "function") {
    return trigger.prompt(signal);
  }

  return trigger.prompt;
}
