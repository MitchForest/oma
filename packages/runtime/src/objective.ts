import type { Objective } from "./types";

export function objective(input: {
  goal: string;
  constraints?: string[];
  success?: string[];
}): Objective {
  return {
    goal: input.goal,
    constraints: input.constraints ?? [],
    success: input.success ?? [],
  };
}
