import { createId } from "./ids";
import type { Artifact, ArtifactKind } from "./types";

export function createArtifact(input: {
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  content: string;
}): Artifact {
  return {
    id: createId("artifact"),
    kind: input.kind,
    name: input.name,
    mediaType: input.mediaType,
    content: input.content,
  };
}

export const artifacts = {
  custom(input: { name: string; mediaType: string; content: string }): Artifact {
    return createArtifact({
      kind: "custom",
      name: input.name,
      mediaType: input.mediaType,
      content: input.content,
    });
  },

  log(name: string, content: string): Artifact {
    return createArtifact({
      kind: "log",
      name,
      mediaType: "text/plain",
      content,
    });
  },

  patch(name: string, content: string): Artifact {
    return createArtifact({
      kind: "patch",
      name,
      mediaType: "text/x-diff",
      content,
    });
  },

  report(name: string, content: string): Artifact {
    return createArtifact({
      kind: "report",
      name,
      mediaType: "text/markdown",
      content,
    });
  },
};
