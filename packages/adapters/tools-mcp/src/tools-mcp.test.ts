import { expect, test } from "bun:test";
import { createMcpToolBundle } from "./index";

test("createMcpToolBundle imports and calls stdio MCP tools", async () => {
  process.env.OMA_MCP_SECRET_TEST_VALUE = "leaked";
  const bundle = await createMcpToolBundle({
    servers: [
      {
        name: "fake",
        command: "bun",
        args: ["--eval", fakeMcpServerScript()],
        env: { OMA_MCP_ALLOWED_VALUE: "visible" }
      }
    ]
  });

  try {
    expect(bundle.tools.map((tool) => tool.name)).toEqual(["fake__echo"]);
    expect(bundle.tools[0]?.effect).toBe("external");
    expect(bundle.tools[0]?.parameters).toEqual({
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"],
      additionalProperties: false
    });

    const result = await bundle.tools[0]?.handler(
      { text: "hello" },
      { sessionId: "session-a", callId: "call-a" }
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "hello:missing:visible" }]
    });
  } finally {
    delete process.env.OMA_MCP_SECRET_TEST_VALUE;
    await bundle.close();
  }
});

test("MCP tool handler rejects non-object arguments before contacting the server", async () => {
  const bundle = await createMcpToolBundle({
    servers: [
      {
        name: "fake",
        command: "bun",
        args: ["--eval", fakeMcpServerScript()]
      }
    ]
  });

  try {
    const tool = bundle.tools[0];

    expect(
      tool?.handler("not an object", { sessionId: "session-a", callId: "call-b" })
    ).rejects.toThrow('MCP tool "fake__echo" requires a JSON object as arguments, got a string');
    expect(
      tool?.handler([1, 2], { sessionId: "session-a", callId: "call-c" })
    ).rejects.toThrow("got an array");
  } finally {
    await bundle.close();
  }
});

test("MCP requests time out and reject instead of hanging forever", async () => {
  // The server never answers anything, so the very first request
  // (initialize, sent during startup) must reject on the timeout.
  const startup = createMcpToolBundle({
    servers: [
      {
        name: "silent",
        command: "bun",
        args: ["--eval", "setInterval(() => {}, 60_000); process.stdin.resume();"],
        requestTimeoutMs: 100
      }
    ]
  });

  expect(startup).rejects.toThrow(
    'MCP request "initialize" to server "silent" timed out after 100ms'
  );
});

test("pending MCP requests reject when the server exits, and later calls fail fast", async () => {
  const bundle = await createMcpToolBundle({
    servers: [
      {
        name: "flaky",
        command: "bun",
        args: ["--eval", fakeMcpServerScript({ exitOnToolCall: true })]
      }
    ]
  });

  try {
    const tool = bundle.tools[0];

    // The server exits without replying to tools/call: the in-flight request
    // must reject on EOF rather than hang.
    expect(
      tool?.handler({ text: "boom" }, { sessionId: "session-a", callId: "call-a" })
    ).rejects.toThrow('MCP server "flaky" closed its stdout stream');

    // After the fatal stream end, the client is closed: new requests reject
    // immediately instead of waiting on a dead child.
    expect(
      tool?.handler({ text: "again" }, { sessionId: "session-a", callId: "call-b" })
    ).rejects.toThrow('MCP server "flaky" closed its stdout stream');
  } finally {
    await bundle.close();
  }
});

function fakeMcpServerScript(options: { exitOnToolCall?: boolean } = {}): string {
  const toolCallBody = options.exitOnToolCall
    ? "process.exit(0);"
    : `send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.text + ":" + (process.env.OMA_MCP_SECRET_TEST_VALUE ?? "missing") + ":" + (process.env.OMA_MCP_ALLOWED_VALUE ?? "missing") }] } });`;

  return `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line) handle(JSON.parse(line));
  }
});
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message.id) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] } });
    return;
  }
  if (message.method === "tools/call") {
    ${toolCallBody}
  }
}
`;
}
