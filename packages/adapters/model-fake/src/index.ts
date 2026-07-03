import type { ModelInput, ModelProvider, ModelTurn } from "@oma/core";

export class FakeModelProvider implements ModelProvider {
  readonly info = { provider: "fake" };

  constructor(private readonly turns: ModelTurn[]) {}

  async turn(input: ModelInput): Promise<ModelTurn> {
    const modelResponses = input.events.filter((event) => event.type === "model.response").length;
    const turn = this.turns[modelResponses];

    if (!turn) {
      // Past the configured turns: return a terminal turn with no content and
      // no tool calls. The harness interprets that as "stop", so re-woken
      // sessions end cleanly instead of looping the last turn to maxSteps.
      return { finishReason: "fake-turns-exhausted" };
    }

    return turn;
  }
}
