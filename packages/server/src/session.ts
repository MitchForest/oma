import type { AppendEventInput, Event, Session, StoredEvent } from "@oma/runtime";

export function observableSession(input: {
  session: Session;
  onAppend(event: StoredEvent): void;
}): Session {
  return {
    id: input.session.id,

    async append<TEvent extends Event>(event: AppendEventInput<TEvent>): Promise<TEvent> {
      const stored = await input.session.append(event);
      input.onAppend(stored);
      return stored;
    },

    async events(): Promise<StoredEvent[]> {
      return await input.session.events();
    },
  };
}
