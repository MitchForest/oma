import {
  indexTools,
  toolParameters,
  type ModelInput,
  type ModelProvider,
  type ModelToolCallRequest,
  type ModelTurn
} from "@oma/core";

export interface AnthropicModelOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  maxOutputTokens?: number;
  temperature?: number;
  anthropicVersion?: string;
  /** Per-request timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number;
}

const defaultTimeoutMs = 120_000;

interface AnthropicResponse {
  id?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  content?: Array<
    | { type: "text"; text?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
    | Record<string, unknown>
  >;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly info;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: AnthropicModelOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.apiKey =
      options.apiKey ??
      process.env[options.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    this.info = {
      provider: "anthropic",
      model: options.model
    };
  }

  async turn(input: ModelInput): Promise<ModelTurn> {
    if (!this.apiKey) {
      throw new Error("Missing API key for Anthropic model provider");
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": this.options.anthropicVersion ?? "2023-06-01"
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxOutputTokens ?? 4096,
        temperature: this.options.temperature,
        system: buildSystem(input),
        messages: buildMessages(input),
        tools: buildTools(input)
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
    }

    let raw: AnthropicResponse;

    try {
      raw = (await response.json()) as AnthropicResponse;
    } catch (error) {
      throw new Error(
        `Anthropic provider returned a non-JSON response (status ${response.status}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const text = (raw.content ?? [])
      .filter((block): block is { type: "text"; text?: string } => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const toolCalls = (raw.content ?? [])
      .map((block): ModelToolCallRequest | undefined => {
        if (block.type !== "tool_use" || typeof block.name !== "string") {
          return undefined;
        }

        return {
          id: typeof block.id === "string" ? block.id : undefined,
          name: block.name,
          args: block.input ?? {}
        };
      })
      .filter((call): call is ModelToolCallRequest => Boolean(call));

    return {
      content: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: raw.stop_reason,
      usage: raw.usage
        ? {
            inputTokens: raw.usage.input_tokens,
            outputTokens: raw.usage.output_tokens,
            totalTokens:
              raw.usage.input_tokens !== undefined && raw.usage.output_tokens !== undefined
                ? raw.usage.input_tokens + raw.usage.output_tokens
                : undefined
          }
        : undefined,
      requestId: response.headers.get("request-id") ?? raw.id,
      raw
    };
  }
}

function buildSystem(input: ModelInput): string {
  return [
    input.context.profile.systemPrompt,
    ...input.context.profile.skills,
    input.context.truncated ? "Some older context was truncated." : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildMessages(input: ModelInput): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const trigger of input.context.triggers) {
    messages.push({
      role: "user",
      content: `External signal ${trigger.source}:${trigger.kind}\n${trigger.payload}`
    });
  }

  for (const event of input.context.events) {
    if (event.type === "message.user") {
      messages.push({ role: "user", content: event.content });
      continue;
    }

    if (event.type === "message.assistant") {
      messages.push({ role: "assistant", content: event.content });
      continue;
    }

    if (event.type === "tool.call") {
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: event.callId,
            name: event.toolName,
            input: event.args
          }
        ]
      });
      continue;
    }

    if (event.type === "tool.result") {
      const projected = input.context.toolResults.find(
        (result) => result.callId === event.callId
      );

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: event.callId,
            content: projected?.content ?? JSON.stringify(event.result)
          }
        ]
      });
      continue;
    }

    if (event.type === "tool.error") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: event.callId,
            is_error: true,
            content: JSON.stringify({ error: event.error })
          }
        ]
      });
    }
  }

  return messages.length > 0 ? messages : [{ role: "user", content: "Continue." }];
}

function buildTools(input: ModelInput): Array<Record<string, unknown>> | undefined {
  const tools = [...indexTools(input.tools).values()]
    .filter((tool) => input.profile.tools.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      input_schema: toolParameters(tool)
    }));

  return tools.length > 0 ? tools : undefined;
}
