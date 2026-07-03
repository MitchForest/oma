import { expect, test } from "bun:test";
import { defineTool, type ModelInput } from "@oma/core";
import { z } from "zod";
import { AnthropicModelProvider } from "./index";

test("AnthropicModelProvider sends messages, tools, and parses tool use", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push(await request.json());
      return Response.json(
        {
          id: "msg-1",
          stop_reason: "tool_use",
          usage: { input_tokens: 12, output_tokens: 4 },
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "read_file",
              input: { path: "README.md" }
            }
          ]
        },
        { headers: { "request-id": "request-1" } }
      );
    }
  });

  try {
    const provider = new AnthropicModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });
    const turn = await provider.turn(modelInput());

    expect(turn).toMatchObject({
      requestId: "request-1",
      finishReason: "tool_use",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      },
      toolCalls: [{ id: "toolu-1", name: "read_file", args: { path: "README.md" } }]
    });
    expect(requests[0]).toMatchObject({
      model: "test-model",
      system: "system\n\nSome older context was truncated.",
      messages: [
        {
          role: "user",
          content: "External signal github:pull_request\n{\"repo\":\"owner/repo\"}"
        },
        { role: "user", content: "bounded context message" }
      ],
      tools: [
        {
          name: "read_file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            additionalProperties: false
          }
        }
      ]
    });
  } finally {
    server.stop(true);
  }
});

test("AnthropicModelProvider parses text responses", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () =>
      Response.json({
        id: "msg-2",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }]
      })
  });

  try {
    const provider = new AnthropicModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });

    expect(await provider.turn(modelInput())).toMatchObject({
      content: "done",
      finishReason: "end_turn"
    });
  } finally {
    server.stop(true);
  }
});

test("AnthropicModelProvider times out stalled requests", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return Response.json({});
    }
  });

  try {
    const provider = new AnthropicModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      timeoutMs: 100
    });

    expect(provider.turn(modelInput())).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});

test("AnthropicModelProvider wraps non-JSON responses with provider context", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => new Response("<html>gateway error</html>", { status: 200 })
  });

  try {
    const provider = new AnthropicModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });

    expect(provider.turn(modelInput())).rejects.toThrow(
      "Anthropic provider returned a non-JSON response (status 200)"
    );
  } finally {
    server.stop(true);
  }
});

function modelInput(): ModelInput {
  const tool = defineTool({
    name: "read_file",
    schema: z.object({ path: z.string() }),
    handler: async () => ({})
  });

  return {
    events: [],
    profile: {
      name: "test",
      mode: "interactive",
      systemPrompt: "system",
      skills: [],
      tools: ["read_file"],
      sandboxPolicy: { kind: "local" },
      modelDefaults: {},
      policy: { toolError: "fail" }
    },
    context: {
      events: [
        {
          id: "event-1",
          sessionId: "session-a",
          offset: 0,
          createdAt: "2026-06-08T00:00:00.000Z",
          type: "message.user",
          content: "bounded context message"
        }
      ],
      profile: {
        name: "test",
        mode: "interactive",
        systemPrompt: "system",
        skills: [],
        tools: ["read_file"]
      },
      messages: [],
      toolResults: [],
      triggers: [
        {
          source: "github",
          kind: "pull_request",
          payload: "{\"repo\":\"owner/repo\"}"
        }
      ],
      truncated: true
    },
    tools: [tool]
  };
}
