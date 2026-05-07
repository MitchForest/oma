import type { Environment } from "./types";

export function noEnvironment(): Environment {
  return {
    kind: "none",
    capabilities: {
      securityBoundary: false,
    },
    bind() {
      return {
        kind: "none",
        capabilities: {
          securityBoundary: false,
        },
      };
    },
  };
}

export const environments = {
  none: noEnvironment,
};
