import type { Profile } from "../profiles/profile";
import type { SessionEvent } from "../session/events";
import type { SessionRecord } from "../session/store";

type ContextMessage = { role: "user" | "assistant"; content: string };

export interface BuildContextOptions {
  maxEvents?: number;
  maxToolResultBytes?: number;
  maxTotalBytes?: number;
}

export interface BuiltContext {
  events: SessionEvent[];
  profile: Pick<Profile, "name" | "mode" | "systemPrompt" | "skills" | "tools">;
  messages: ContextMessage[];
  toolResults: Array<{ callId: string; toolName: string; content: string }>;
  triggers: Array<{ source: string; kind: string; payload: string }>;
  truncated: boolean;
}

const defaultOptions: Required<BuildContextOptions> = {
  maxEvents: 80,
  maxToolResultBytes: 12_000,
  maxTotalBytes: 80_000
};

export function buildContext(
  session: SessionRecord,
  profile: Profile,
  options: BuildContextOptions = {}
): BuiltContext {
  const limits = { ...defaultOptions, ...options };
  const recent = session.events.slice(-limits.maxEvents);
  let budget = limits.maxTotalBytes;
  let truncated = session.events.length > recent.length;

  return {
    events: recent,
    profile: {
      name: profile.name,
      mode: profile.mode,
      systemPrompt: profile.systemPrompt,
      skills: profile.skills,
      tools: profile.tools
    },
    messages: recent.flatMap((event): ContextMessage[] => {
      if (event.type === "message.user") {
        const content = takeBudget(event.content, budget);
        budget -= byteLength(content);
        truncated ||= content !== event.content;
        return [{ role: "user" as const, content }];
      }

      if (event.type === "message.assistant") {
        const content = takeBudget(event.content, budget);
        budget -= byteLength(content);
        truncated ||= content !== event.content;
        return [{ role: "assistant" as const, content }];
      }

      return [];
    }),
    toolResults: recent.flatMap((event) => {
      if (event.type !== "tool.result") {
        return [];
      }

      const raw = JSON.stringify(event.result);
      const content = takeBudget(raw, Math.min(budget, limits.maxToolResultBytes));
      budget -= byteLength(content);
      truncated ||= content !== raw;

      return [
        {
          callId: event.callId,
          toolName: event.toolName,
          content
        }
      ];
    }),
    triggers: recent.flatMap((event) => {
      if (event.type !== "trigger.received") {
        return [];
      }

      const raw = JSON.stringify(event.payload);
      const payload = takeBudget(raw, Math.min(budget, 8_000));
      budget -= byteLength(payload);
      truncated ||= payload !== raw;

      return [
        {
          source: event.source,
          kind: event.kind,
          payload
        }
      ];
    }),
    truncated
  };
}

function takeBudget(value: string, budget: number): string {
  if (byteLength(value) <= budget) {
    return value;
  }

  const bytes = Buffer.from(value).subarray(0, Math.max(0, budget - 24));
  // Cutting on a byte boundary can split a multi-byte character; decode
  // leniently and trim the replacement characters the cut produces.
  const text = new TextDecoder().decode(bytes).replace(/�+$/, "");
  return `${text}...[truncated]`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}
