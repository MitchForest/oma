# @oma/adapter-model-openai-compatible

OpenAI-compatible chat completions model adapter for OMA.

The adapter implements `ModelProvider.turn`, sends the bounded OMA context as chat messages, exposes profile-selected tools as function tools, and converts current Zod tool schemas into JSON Schema for the provider.

```ts
import { OpenAICompatibleModelProvider } from "@oma/adapter-model-openai-compatible";

const model = new OpenAICompatibleModelProvider({
  model: "gpt-4.1-mini",
  apiKey: process.env.OPENAI_API_KEY
});
```

The CLI can use this adapter with:

```json
{
  "model": {
    "kind": "openai-compatible",
    "model": "gpt-4.1-mini",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```
