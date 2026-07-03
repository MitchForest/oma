import type { Profile } from "../profiles/profile";
import type { SessionStore } from "../session/store";

export interface SpawnOptions {
  id?: string;
  initialMessage?: string;
  metadata?: Record<string, unknown>;
}

export async function spawn(
  store: SessionStore,
  profile: Profile,
  options: SpawnOptions = {}
): Promise<string> {
  const sessionId = await store.createSession({
    id: options.id,
    metadata: options.metadata
  });

  await store.appendEvent(sessionId, {
    type: "session.started",
    profileName: profile.name,
    mode: profile.mode
  });

  if (options.initialMessage) {
    await send(store, sessionId, options.initialMessage);
  }

  return sessionId;
}

export async function send(
  store: SessionStore,
  entityId: string,
  message: string
): Promise<void> {
  await store.appendEvent(entityId, {
    type: "message.user",
    content: message
  });
}
