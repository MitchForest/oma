import { defineTool, toJsonValue, type AnyTool, type JsonSchemaObject } from "@oma/core";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  namespaceTools?: boolean;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  requestTimeoutMs?: number;
}

export interface McpToolsOptions {
  servers: McpServerConfig[];
}

export interface McpToolBundle {
  tools: AnyTool[];
  close(): Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: JsonSchemaObject;
}

const defaultRequestTimeoutMs = 60_000;

export async function createMcpTools(options: McpToolsOptions): Promise<AnyTool[]> {
  return (await createMcpToolBundle(options)).tools;
}

export async function createMcpToolBundle(options: McpToolsOptions): Promise<McpToolBundle> {
  const clients = await Promise.all(options.servers.map((server) => McpClient.start(server)));
  const tools = clients.flatMap((client) => client.tools);

  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    }
  };
}

class McpClient {
  readonly tools: AnyTool[];
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private buffer = Buffer.alloc(0);
  private closedError: Error | undefined;

  private constructor(
    private readonly config: McpServerConfig,
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "ignore">
  ) {
    this.tools = [];
    this.requestTimeoutMs = config.requestTimeoutMs ?? defaultRequestTimeoutMs;
    void this.readLoop();
  }

  static async start(config: McpServerConfig): Promise<McpClient> {
    const proc = Bun.spawn([config.command, ...(config.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      // Drop stderr: an unread pipe deadlocks chatty servers at the ~64KB
      // pipe buffer, and MCP servers are free to log there.
      stderr: "ignore",
      env: subprocessEnv(config.env)
    });
    const client = new McpClient(config, proc);

    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "oma", version: "0.0.0" }
    });
    await client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    const toolDefinitions = parseToolDefinitions(listed);

    client.tools.push(
      ...toolDefinitions.map((tool) =>
        defineTool({
          name: client.toolName(tool.name),
          description: tool.description,
          // MCP servers do not declare their side effects, so every MCP tool
          // is conservatively treated as "external" (may touch the outside
          // world); the harness must never assume an MCP call is read-only.
          effect: "external",
          capabilities: [`mcp.${config.name}.${tool.name}`],
          parameters: tool.inputSchema ?? emptyObjectSchema(),
          handler: async (args) => {
            // MCP tools carry raw JSON Schema (no zod), so the harness never
            // validated the args shape; tools/call requires an object.
            if (args !== undefined && !isPlainObject(args)) {
              throw new Error(
                `MCP tool "${client.toolName(tool.name)}" requires a JSON object as arguments, got ${describeValue(args)}`
              );
            }

            const result = await client.request("tools/call", {
              name: tool.name,
              arguments: args ?? {}
            });

            return normalizeMcpResult(result);
          }
        })
      )
    );

    return client;
  }

  async close(): Promise<void> {
    this.closedError ??= new Error(`MCP client for server "${this.config.name}" is closed`);

    try {
      this.proc.stdin.end();
    } catch {
      // Ignore close races; the child may have already exited.
    }

    this.proc.kill();
    await this.proc.exited;
    this.flushPending(this.closedError);
  }

  private toolName(name: string): string {
    return this.config.namespaceTools === false ? name : `${this.config.name}__${name}`;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closedError) {
      throw this.closedError;
    }

    const id = this.nextId++;
    const response = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request "${method}" to server "${this.config.name}" timed out after ${this.requestTimeoutMs}ms`
          )
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    await this.write({ jsonrpc: "2.0", id, method, params });

    const received = await response;

    if (received.error) {
      throw new Error(received.error.message);
    }

    return received.result;
  }

  private async write(message: JsonRpcRequest | Record<string, unknown>): Promise<void> {
    // MCP stdio framing: newline-delimited JSON, one message per line.
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    let failure: Error | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          return;
        }

        this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
        this.drainBuffer();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      // Whether the stream errored or hit clean EOF, no response can arrive
      // anymore: mark the client closed and reject everything in flight.
      this.closedError ??=
        failure ?? new Error(`MCP server "${this.config.name}" closed its stdout stream`);
      this.flushPending(this.closedError);
    }
  }

  private drainBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a);

      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let message: JsonRpcResponse;

      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        throw new Error(
          `MCP server "${this.config.name}" sent a non-JSON line: ${line.slice(0, 200)}`
        );
      }

      this.handleMessage(message);
    }
  }

  private flushPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    this.pending.clear();
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") {
      return;
    }

    const entry = this.pending.get(message.id);

    if (!entry) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }
}

function parseToolDefinitions(value: unknown): McpToolDefinition[] {
  const tools = (value as { tools?: unknown }).tools;

  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }

    const candidate = tool as Record<string, unknown>;

    if (typeof candidate.name !== "string") {
      return [];
    }

    return [
      {
        name: candidate.name,
        description:
          typeof candidate.description === "string" ? candidate.description : undefined,
        inputSchema:
          candidate.inputSchema && typeof candidate.inputSchema === "object"
            ? (candidate.inputSchema as JsonSchemaObject)
            : undefined
      }
    ];
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  return `a ${typeof value}`;
}

function normalizeMcpResult(value: unknown): unknown {
  return toJsonValue(value, "mcp.result");
}

function subprocessEnv(env: Record<string, string> | undefined): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    ...env
  };
}

function emptyObjectSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {},
    additionalProperties: true
  };
}
