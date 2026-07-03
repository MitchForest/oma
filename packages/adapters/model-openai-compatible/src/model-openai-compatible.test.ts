import { expect, test } from "bun:test";
import {
  OpenAICompatibleModelProvider,
  zodToJsonSchema
} from "./index";
import { z } from "zod";
import { defineTool, type ModelInput } from "@oma/core";

test("zodToJsonSchema exposes concrete tool argument contracts", () => {
  const schema = z.object({
    path: z.string(),
    maxResults: z.number().int().positive().default(100),
    cached: z.boolean().optional()
  });

  expect(zodToJsonSchema(schema)).toEqual({
    type: "object",
    properties: {
      path: { type: "string" },
      maxResults: { type: "number" },
      cached: { type: "boolean" }
    },
    required: ["path"],
    additionalProperties: false
  });
});

test("OpenAICompatibleModelProvider sends messages, tools, and parses tool calls", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push(await request.json());
      return Response.json({
        id: "response-1",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15
        },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}"
                  }
                }
              ]
            }
          }
        ]
      }, { headers: { "x-request-id": "request-1" } });
    }
  });

  try {
    const provider = new OpenAICompatibleModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });
    const turn = await provider.turn(modelInput());

    expect(turn.toolCalls).toEqual([
      { id: "call-1", name: "read_file", args: { path: "README.md" } }
    ]);
    expect(turn).toMatchObject({
      requestId: "request-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    });
    expect(requests[0]).toMatchObject({
      model: "test-model",
      messages: [
        {
          role: "system",
          content: "system\n\nSome older context was truncated."
        },
        {
          role: "user",
          content: "External signal github:pull_request\n{\"repo\":\"owner/repo\"}"
        },
        {
          role: "user",
          content: "bounded context message"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" }
              },
              required: ["path"],
              additionalProperties: false
            }
          }
        }
      ]
    });
  } finally {
    server.stop(true);
  }
});

test("OpenAICompatibleModelProvider omits tools and tool_choice for tool-less profiles", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        id: "response-1",
        choices: [{ finish_reason: "stop", message: { content: "done" } }]
      });
    }
  });

  try {
    const provider = new OpenAICompatibleModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });
    const turn = await provider.turn(modelInput({ tools: [] }));

    expect(turn.content).toBe("done");
    expect(requests[0]).not.toContainKey("tools");
    expect(requests[0]).not.toContainKey("tool_choice");
  } finally {
    server.stop(true);
  }
});

test("OpenAICompatibleModelProvider times out stalled requests", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return Response.json({});
    }
  });

  try {
    const provider = new OpenAICompatibleModelProvider({
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

test("OpenAICompatibleModelProvider surfaces malformed tool arguments naming the tool", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () =>
      Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  function: { name: "read_file", arguments: "{not json" }
                }
              ]
            }
          }
        ]
      })
  });

  try {
    const provider = new OpenAICompatibleModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });

    expect(provider.turn(modelInput())).rejects.toThrow(
      'Model returned malformed JSON arguments for tool "read_file"'
    );
  } finally {
    server.stop(true);
  }
});

test("OpenAICompatibleModelProvider wraps non-JSON responses with provider context", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => new Response("<html>gateway error</html>", { status: 200 })
  });

  try {
    const provider = new OpenAICompatibleModelProvider({
      model: "test-model",
      apiKey: "test-key",
      baseUrl: `http://127.0.0.1:${server.port}/v1`
    });

    expect(provider.turn(modelInput())).rejects.toThrow(
      "OpenAI-compatible provider returned a non-JSON response (status 200)"
    );
  } finally {
    server.stop(true);
  }
});

function modelInput(overrides: { tools?: string[] } = {}): ModelInput {
  const tool = defineTool({
    name: "read_file",
    schema: z.object({ path: z.string() }),
    handler: async () => ({})
  });
  const toolNames = overrides.tools ?? ["read_file"];

  return {
    events: [
      {
        id: "event-1",
        sessionId: "session-a",
        offset: 0,
        createdAt: "2026-06-08T00:00:00.000Z",
        type: "message.user",
        content: "raw events should not be used"
      }
    ],
    profile: {
      name: "test",
      mode: "interactive",
      systemPrompt: "system",
      skills: [],
      tools: toolNames,
      sandboxPolicy: { kind: "local" },
      modelDefaults: {},
      policy: { toolError: "fail" }
    },
    context: {
      events: [
        {
          id: "event-2",
          sessionId: "session-a",
          offset: 1,
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
        tools: toolNames
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
