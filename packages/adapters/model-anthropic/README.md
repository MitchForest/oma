# @oma/adapter-model-anthropic

Anthropic Messages API adapter for OMA.

```ts
import { AnthropicModelProvider } from "@oma/adapter-model-anthropic";

const model = new AnthropicModelProvider({
  model: "claude-sonnet-4-5",
  apiKey: process.env.ANTHROPIC_API_KEY
});
```

The adapter depends only on `@oma/core` and uses `fetch` directly. It maps bounded OMA context into Anthropic messages and exposes OMA tools through JSON Schema parameters.
