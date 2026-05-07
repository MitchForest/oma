import { createArtifact } from "./artifacts";
import type { Artifact, ArtifactCollector, ArtifactKind, BoundEnvironment } from "./types";

function requireFilesystem(environment: BoundEnvironment) {
  if (!environment.filesystem) {
    throw new Error("Environment does not provide filesystem capability.");
  }

  return environment.filesystem;
}

function requireGit(environment: BoundEnvironment) {
  if (!environment.git) {
    throw new Error("Environment does not provide git capability.");
  }

  return environment.git;
}

export function fileCollector(
  path: string,
  options: {
    kind?: ArtifactKind;
    mediaType?: string;
    name?: string;
  } = {},
): ArtifactCollector {
  return {
    id: `file:${path}`,

    async collect({ environment }): Promise<Artifact> {
      const content = await requireFilesystem(environment).readText(path);
      const kind = options.kind ?? "custom";

      return createArtifact({
        kind,
        name: options.name ?? path,
        mediaType: options.mediaType ?? "text/plain",
        content,
      });
    },
  };
}

export function reportCollector(path: string): ArtifactCollector {
  return fileCollector(path, {
    kind: "report",
    mediaType: "text/markdown",
  });
}

export function gitDiffCollector(name = "changes.patch"): ArtifactCollector {
  return {
    id: "git.diff",

    async collect({ environment }): Promise<Artifact> {
      return createArtifact({
        kind: "patch",
        name,
        mediaType: "text/x-diff",
        content: await requireGit(environment).diff(),
      });
    },
  };
}

export function directoryCollector(
  path: string,
  options: {
    name?: string;
  } = {},
): ArtifactCollector {
  return {
    id: `directory:${path}`,

    async collect({ environment }): Promise<Artifact> {
      const files = await requireFilesystem(environment).list(path);
      return createArtifact({
        kind: "directory",
        name: options.name ?? path,
        mediaType: "application/vnd.oma.directory-manifest+json",
        content: `${JSON.stringify({ path, files }, null, 2)}\n`,
      });
    },
  };
}

export const collectors = {
  directory: directoryCollector,
  file: fileCollector,
  gitDiff: gitDiffCollector,
  report: reportCollector,
};
