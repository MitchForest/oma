import type { BuiltContext } from "../harness/context";
import type { Profile } from "../profiles/profile";
import type { SessionEvent } from "../session/events";
import type { ToolRegistry } from "../tools/tool";

export interface ModelInput {
  events: SessionEvent[];
  profile: Profile;
  context: BuiltContext;
  tools: ToolRegistry;
}

export interface ModelToolCallRequest {
  id?: string;
  name: string;
  args: unknown;
}

export interface ModelProviderInfo {
  provider: string;
  model?: string;
}

export interface ModelTurn {
  content?: string;
  toolCalls?: ModelToolCallRequest[];
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  requestId?: string;
  raw?: unknown;
}

export interface ModelProvider {
  info?: ModelProviderInfo;
  turn(input: ModelInput): Promise<ModelTurn>;
}
