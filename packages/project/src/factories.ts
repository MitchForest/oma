import { resolve } from "node:path";
import { localEnvironment } from "@oma/environment-local";
import { claudeCodeHarness } from "@oma/harness-claude-code";
import { codexCliHarness } from "@oma/harness-codex-cli";
import { opencodeHarness } from "@oma/harness-opencode";
import { piHarness } from "@oma/harness-pi";
import { artifacts, harnesses, sessions } from "@oma/runtime";
import { sqliteSessions } from "@oma/session-sqlite";
import { validators } from "@oma/validators";
import type { JsonSchema } from "@oma/validators";
import type { Artifact, Environment, Harness, SessionStore, Validator } from "@oma/runtime";
import { ProjectError } from "./errors";
import type { ResolvedProject, ValidatorConfig } from "./types";

function mockArtifacts(options: Record<string, unknown>): Artifact[] {
  const value = options.artifacts;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProjectError("Mock harness option artifacts must be an array.");
  }

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new ProjectError(`Mock artifact ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const name = record.name;
    const content = record.content;
    if (typeof name !== "string" || typeof content !== "string") {
      throw new ProjectError(`Mock artifact ${index} requires string name and content.`);
    }
    const kind = typeof record.kind === "string" ? record.kind : "report";
    if (kind === "report") {
      return artifacts.report(name, content);
    }
    if (kind === "log") {
      return artifacts.log(name, content);
    }
    return artifacts.custom({
      name,
      content,
      mediaType: "text/plain",
    });
  });
}

export function createEnvironment(project: ResolvedProject): Environment {
  return localEnvironment({
    workspace: project.workspace,
  });
}

export function createHarness(project: ResolvedProject): Harness {
  const options = project.harness.options ?? {};

  switch (project.harness.kind) {
    case "claude-code":
      return claudeCodeHarness(options);
    case "codex-cli":
      return codexCliHarness(options);
    case "mock":
      return harnesses.mock({
        artifacts: mockArtifacts(options),
      });
    case "opencode":
      return opencodeHarness(options);
    case "pi":
      return piHarness(options);
  }
}

export function createSessionStore(project: ResolvedProject): SessionStore {
  if (project.session.kind === "sqlite") {
    return sqliteSessions({
      path: resolve(project.root, project.session.path),
    });
  }

  return sessions.jsonl({
    dir: resolve(project.root, project.session.dir),
  });
}

export function createServerSessionStore(project: ResolvedProject): SessionStore {
  return sqliteSessions({
    path: project.databasePath,
  });
}

function createValidator(config: ValidatorConfig): Validator {
  if (config.kind === "artifactExists") {
    return validators.artifactExists(config.paths ?? config.path ?? []);
  }

  if (
    config.kind === "command" ||
    config.kind === "test" ||
    config.kind === "typecheck" ||
    config.kind === "lint"
  ) {
    const input: Parameters<typeof validators.command>[0] = {
      command: config.command,
    };
    if (config.args) {
      input.args = config.args;
    }
    if (config.cwd) {
      input.cwd = config.cwd;
    }
    if (config.id) {
      input.id = config.id;
    }
    if (config.timeoutMs !== undefined) {
      input.timeoutMs = config.timeoutMs;
    }
    if (config.kind === "test") {
      return validators.test(input);
    }
    if (config.kind === "typecheck") {
      return validators.typecheck(input);
    }
    if (config.kind === "lint") {
      return validators.lint(input);
    }
    return validators.command(input);
  }

  if (config.kind === "gitDiff") {
    return validators.gitDiff(config);
  }

  if (config.kind === "schema") {
    const input: Parameters<typeof validators.schema>[0] = {
      artifact: config.artifact,
      schema: config.schema as JsonSchema,
    };
    if (config.id) {
      input.id = config.id;
    }
    return validators.schema(input);
  }

  if (config.kind === "all") {
    const children = config.validators.map(createValidator);
    return validators.all(config.id, children);
  }
  if (config.kind === "any") {
    const children = config.validators.map(createValidator);
    return validators.any(config.id, children);
  }
  if (config.kind === "sequence") {
    const children = config.validators.map(createValidator);
    return validators.sequence(config.id, children);
  }

  throw new ProjectError(`Unsupported validator kind.`);
}

export function createValidators(project: ResolvedProject): Validator[] {
  return project.validation.map(createValidator);
}
