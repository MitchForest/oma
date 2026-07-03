# @oma/adapter-tools-mcp

Import MCP stdio servers as OMA tools.

```ts
import { createMcpToolBundle } from "@oma/adapter-tools-mcp";

const bundle = await createMcpToolBundle({
  servers: [
    {
      name: "example",
      command: "node",
      args: ["server.js"]
    }
  ]
});

try {
  // bundle.tools can be added to an OMA runtime.
} finally {
  await bundle.close();
}
```

Tool names are namespaced as `<server>__<tool>` by default to avoid collisions.

Transport is MCP stdio framing: newline-delimited JSON, one JSON-RPC message per
line. Server stderr is dropped. Each request is bounded by `requestTimeoutMs`
(default 60s) per server config. Because MCP servers do not declare their side
effects, every imported tool is conservatively marked `effect: "external"`.
