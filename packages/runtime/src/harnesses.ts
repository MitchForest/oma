import type { Artifact, Harness, HarnessInput, HarnessResult } from "./types";

export function mockHarness(input: { artifacts?: Artifact[] } = {}): Harness {
  return {
    id: "mock",

    async run() {
      return {
        artifacts: input.artifacts ?? [],
      };
    },
  };
}

export function customHarness(run: (input: HarnessInput) => Promise<HarnessResult>): Harness {
  return {
    id: "custom",
    run,
  };
}

export const harnesses = {
  custom: customHarness,
  fromFn: customHarness,
  mock: mockHarness,
};
