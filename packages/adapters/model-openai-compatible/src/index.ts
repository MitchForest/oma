import {
  indexTools,
  toolParameters,
  type ModelInput,
  type ModelProvider,
  type ModelToolCallRequest,
  type ModelTurn
} from "@oma/core";

export { zodToJsonSchema } from "@oma/core";

export interface OpenAICompatibleModelOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Per-request timeout in milliseconds. Defaults to 120_000. */
  timeoutMs?: number;
}

const defaultTimeoutMs = 120_000;

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly info;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAICompatibleModelOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.info = {
      provider: "openai-compatible",
      model: options.model
    };
  }

  async turn(input: ModelInput): Promise<ModelTurn> {
    if (!this.apiKey) {
      throw new Error("Missing API key for OpenAI-compatible model provider");
    }

    const tools = buildTools(input);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: this.options.temperature,
        max_tokens: this.options.maxOutputTokens,
        messages: buildMessages(input),
        // `tool_choice` without `tools` is a 400 on OpenAI-compatible APIs:
        // send both together or neither.
        ...(tools ? { tools, tool_choice: "auto" } : {})
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
    }

    let raw: ChatCompletionResponse;

    try {
      raw = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      throw new Error(
        `OpenAI-compatible provider returned a non-JSON response (status ${response.status}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const choice = raw.choices?.[0];
    const message = choice?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .map((call): ModelToolCallRequest | undefined => {
        const name = call.function?.name;

        if (!name) {
          return undefined;
        }

        return {
          id: call.id,
          name,
          args: parseToolArgs(name, call.function?.arguments)
        };
      })
      .filter((call): call is ModelToolCallRequest => Boolean(call));

    return {
      content: message?.content ?? undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice?.finish_reason,
      usage: raw.usage
        ? {
            inputTokens: raw.usage.prompt_tokens,
            outputTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens
          }
        : undefined,
      requestId: response.headers.get("x-request-id") ?? raw.id,
      raw
    };
  }
}

function buildMessages(input: ModelInput): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: [
        input.context.profile.systemPrompt,
        ...input.context.profile.skills,
        input.context.truncated ? "Some older context was truncated." : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    }
  ];

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
        content: null,
        tool_calls: [
          {
            id: event.callId,
            type: "function",
            function: {
              name: event.toolName,
              arguments: JSON.stringify(event.args)
            }
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
        role: "tool",
        tool_call_id: event.callId,
        content: projected?.content ?? JSON.stringify(event.result)
      });
      continue;
    }

    if (event.type === "tool.error") {
      messages.push({
        role: "tool",
        tool_call_id: event.callId,
        content: JSON.stringify({ error: event.error })
      });
    }
  }

  return messages;
}

function buildTools(input: ModelInput): Array<Record<string, unknown>> | undefined {
  const tools = [...indexTools(input.tools).values()]
    .filter((tool) => input.profile.tools.includes(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: toolParameters(tool)
      }
    }));

  return tools.length > 0 ? tools : undefined;
}

function parseToolArgs(toolName: string, value: string | undefined): unknown {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Model returned malformed JSON arguments for tool "${toolName}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
