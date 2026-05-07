import { readFile } from "node:fs/promises";
import type { ReviewRequest, TriggerSource } from "./types";

export type TriggerParseResult =
  | {
      ok: true;
      command: string;
      verbose: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

const triggerPatterns = [/^oma\s+review\b/i, /^bugbot\s+run\b/i, /^cursor\s+review\b/i];

function boolOption(text: string, key: string): boolean {
  return new RegExp(`\\b${key}=true\\b`, "i").test(text);
}

export function parseTriggerComment(body: string): TriggerParseResult {
  const command = body.trim();
  if (!triggerPatterns.some((pattern) => pattern.test(command))) {
    return {
      ok: false,
      reason: "Comment does not contain an OMA review trigger.",
    };
  }

  return {
    ok: true,
    command,
    verbose: boolOption(command, "verbose"),
  };
}

function readRepository(env: Record<string, string | undefined>) {
  const fullName = env.GITHUB_REPOSITORY;
  if (!fullName || !fullName.includes("/")) {
    throw new Error("GITHUB_REPOSITORY must be set as owner/name.");
  }

  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new Error("GITHUB_REPOSITORY must be set as owner/name.");
  }

  return {
    owner,
    name,
    fullName,
  };
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function pullRequestFromEvent(event: Record<string, unknown>): Record<string, unknown> {
  const direct = event.pull_request;
  if (direct) {
    return recordValue(direct, "pull_request");
  }

  const issue = recordValue(event.issue, "issue");
  if (!issue.pull_request) {
    throw new Error("Issue comment event is not attached to a pull request.");
  }

  return {
    number: issue.number,
    head: {
      sha: "",
    },
    base: {
      sha: "",
    },
  };
}

function sourceFromEventName(eventName: string | undefined): TriggerSource {
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return "pull_request";
  }
  if (eventName === "workflow_dispatch") {
    return "workflow_dispatch";
  }
  return "issue_comment";
}

export async function reviewRequestFromGithubEvent(input: {
  eventPath: string;
  env: Record<string, string | undefined>;
}): Promise<ReviewRequest | undefined> {
  const event = recordValue(JSON.parse(await readFile(input.eventPath, "utf8")), "event");
  const source = sourceFromEventName(input.env.GITHUB_EVENT_NAME);
  const repository = readRepository(input.env);
  const pullRequest = pullRequestFromEvent(event);

  let command = "pull_request";
  let verbose = false;

  if (source === "issue_comment") {
    const comment = recordValue(event.comment, "comment");
    const parsed = parseTriggerComment(stringValue(comment.body, "comment.body"));
    if (!parsed.ok) {
      return undefined;
    }
    command = parsed.command;
    verbose = parsed.verbose;
  }

  const head = recordValue(pullRequest.head, "pull_request.head");
  const base = recordValue(pullRequest.base, "pull_request.base");

  return {
    repository,
    pullRequest: {
      number: numberValue(pullRequest.number, "pull_request.number"),
      headSha: typeof head.sha === "string" ? head.sha : "",
      baseSha: typeof base.sha === "string" ? base.sha : "",
    },
    trigger: {
      source,
      command,
      verbose,
    },
  };
}

export async function reviewRequestFromFixture(fixtureDir: string): Promise<ReviewRequest> {
  const event = recordValue(
    JSON.parse(await readFile(`${fixtureDir}/event.json`, "utf8")),
    "fixture event",
  );
  const repository = recordValue(event.repository, "repository");
  const pullRequest = recordValue(event.pullRequest, "pullRequest");
  const trigger = recordValue(event.trigger, "trigger");
  const parsed = parseTriggerComment(stringValue(trigger.command, "trigger.command"));

  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }

  const fullName = stringValue(repository.fullName, "repository.fullName");
  const [owner, name] = fullName.split("/");
  if (!owner || !name) {
    throw new Error("repository.fullName must be owner/name.");
  }

  return {
    repository: {
      owner,
      name,
      fullName,
    },
    pullRequest: {
      number: numberValue(pullRequest.number, "pullRequest.number"),
      headSha: stringValue(pullRequest.headSha, "pullRequest.headSha"),
      baseSha: stringValue(pullRequest.baseSha, "pullRequest.baseSha"),
    },
    trigger: {
      source: "fixture",
      command: parsed.command,
      verbose: parsed.verbose,
    },
  };
}
