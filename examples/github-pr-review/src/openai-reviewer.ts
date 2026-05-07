import type {
  BoundEnvironment,
  CommandInput,
  CommandResult,
  Harness,
  HarnessInput,
} from "@oma/runtime";
import { artifacts } from "@oma/runtime";
import { renderFindingsMarkdown } from "./findings";
import { reviewInput, reviewInstructions } from "./review-policy";
import type { PullRequestContext, ReviewFindingsArtifact } from "./types";

type ResponsesOutputItem =
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type ResponsesBody = {
  output?: ResponsesOutputItem[];
  output_text?: string;
};

export type OpenAIReviewHarnessInput = {
  apiKey: string;
  context: PullRequestContext;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  maxToolRounds?: number;
  maxReadBytes?: number;
  maxCommandBytes?: number;
  fetch?: FetchLike;
};

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

const defaultModel = "gpt-5.5";
const defaultReasoningEffort: ReasoningEffort = "medium";
const defaultMaxToolRounds = 8;
const defaultMaxReadBytes = 24_000;
const defaultMaxCommandBytes = 24_000;

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return `${text.slice(0, end)}\n... truncated`;
}

function assertToolArgs(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isSensitivePath(path: string): boolean {
  return (
    path === ".env" ||
    path.startsWith(".env.") ||
    path.startsWith(".git/") ||
    path.includes("/.git/") ||
    path.includes("node_modules/") ||
    path.includes("/node_modules/") ||
    path.includes(".oma/")
  );
}

function commandOutput(result: CommandResult, maxBytes: number): string {
  return truncate(
    JSON.stringify(
      {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ),
    maxBytes,
  );
}

async function runReadOnlyCommand(input: {
  environment: BoundEnvironment;
  command: CommandInput;
  maxBytes: number;
}): Promise<string> {
  if (!input.environment.shell) {
    return "Shell capability is unavailable.";
  }
  const result = await input.environment.shell.exec(input.command);
  return commandOutput(result, input.maxBytes);
}

async function executeTool(input: {
  environment: BoundEnvironment;
  name: string;
  args: Record<string, unknown>;
  maxReadBytes: number;
  maxCommandBytes: number;
}): Promise<string> {
  if (input.name === "list_files") {
    if (!input.environment.filesystem) {
      return "Filesystem capability is unavailable.";
    }
    const path = optionalString(input.args, "path") ?? ".";
    if (isSensitivePath(path)) {
      return "Refusing to list sensitive path.";
    }
    const files = await input.environment.filesystem.list(path);
    const filtered = files
      .map((file) => file.path)
      .filter((file) => !isSensitivePath(file))
      .slice(0, 400);
    return filtered.join("\n");
  }

  if (input.name === "read_file") {
    if (!input.environment.filesystem) {
      return "Filesystem capability is unavailable.";
    }
    const path = optionalString(input.args, "path");
    if (!path) {
      return "read_file requires path.";
    }
    if (isSensitivePath(path)) {
      return "Refusing to read sensitive path.";
    }
    return truncate(await input.environment.filesystem.readText(path), input.maxReadBytes);
  }

  if (input.name === "grep") {
    const query = optionalString(input.args, "query");
    const path = optionalString(input.args, "path") ?? ".";
    if (!query) {
      return "grep requires query.";
    }
    if (isSensitivePath(path)) {
      return "Refusing to grep sensitive path.";
    }
    return await runReadOnlyCommand({
      environment: input.environment,
      maxBytes: input.maxCommandBytes,
      command: {
        command: "rg",
        args: ["--line-number", "--no-heading", "--color", "never", query, path],
        timeoutMs: 10_000,
      },
    });
  }

  if (input.name === "git_diff") {
    if (input.environment.git) {
      return truncate(await input.environment.git.diff(), input.maxCommandBytes);
    }
    return await runReadOnlyCommand({
      environment: input.environment,
      maxBytes: input.maxCommandBytes,
      command: {
        command: "git",
        args: ["diff", "--binary"],
        timeoutMs: 10_000,
      },
    });
  }

  return `Unknown tool: ${input.name}`;
}

function tools() {
  return [
    {
      type: "function",
      name: "list_files",
      description: "List files under a repository path. This is read-only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
          },
        },
        required: ["path"],
      },
      strict: true,
    },
    {
      type: "function",
      name: "read_file",
      description: "Read a text file from the repository. This is read-only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
          },
        },
        required: ["path"],
      },
      strict: true,
    },
    {
      type: "function",
      name: "grep",
      description: "Search repository text with ripgrep. This is read-only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
          },
          path: {
            type: "string",
          },
        },
        required: ["query", "path"],
      },
      strict: true,
    },
    {
      type: "function",
      name: "git_diff",
      description: "Read the current git diff. This is read-only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
      },
      strict: true,
    },
  ];
}

function reviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "summary", "findings"],
    properties: {
      schemaVersion: {
        type: "number",
      },
      summary: {
        type: "string",
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "risk",
            "confidence",
            "category",
            "file",
            "line",
            "side",
            "title",
            "body",
            "whyItMatters",
            "suggestedFix",
            "validation",
            "evidence",
          ],
          properties: {
            id: {
              type: "string",
            },
            risk: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            category: {
              type: "string",
              enum: [
                "api_contract",
                "backwards_compatibility",
                "concurrency",
                "data_integrity",
                "database_migration",
                "error_handling",
                "hidden_path",
                "logic_error",
                "observability",
                "performance",
                "security",
                "tech_debt",
                "test_gap",
                "unnecessary_shim",
              ],
            },
            file: {
              type: "string",
            },
            line: {
              type: "number",
            },
            side: {
              type: "string",
              enum: ["RIGHT", "LEFT"],
            },
            title: {
              type: "string",
            },
            body: {
              type: "string",
            },
            whyItMatters: {
              type: "string",
            },
            suggestedFix: {
              type: "string",
            },
            validation: {
              type: "array",
              items: {
                type: "string",
              },
            },
            evidence: {
              type: "array",
              items: {
                type: "string",
              },
            },
          },
        },
      },
    },
  };
}

function outputText(body: ResponsesBody): string {
  if (body.output_text) {
    return body.output_text;
  }

  const text = body.output
    ?.flatMap((item) => {
      const content = "content" in item ? item.content : undefined;
      if (!Array.isArray(content)) {
        return [];
      }
      return content.flatMap((part) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return typeof part.text === "string" ? [part.text] : [];
        }
        return [];
      });
    })
    .join("");
  return text ?? "";
}

async function createResponse(input: {
  apiKey: string;
  fetchImpl: FetchLike;
  model: string;
  reasoningEffort: ReasoningEffort;
  conversation: unknown[];
  allowTools: boolean;
}): Promise<ResponsesBody> {
  const requestBody: Record<string, unknown> = {
    model: input.model,
    reasoning: {
      effort: input.reasoningEffort,
    },
    instructions: reviewInstructions(),
    input: input.conversation,
    text: {
      format: {
        type: "json_schema",
        name: "oma_pr_review",
        strict: true,
        schema: reviewSchema(),
      },
    },
  };
  if (input.allowTools) {
    requestBody.tools = tools();
  }

  const response = await input.fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const responseBody = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message =
      typeof responseBody === "object" && responseBody !== null && "error" in responseBody
        ? JSON.stringify(responseBody.error)
        : response.statusText;
    throw new Error(`OpenAI review failed: ${String(response.status)} ${message}`);
  }
  return responseBody as ResponsesBody;
}

function findingsArtifacts(findings: ReviewFindingsArtifact) {
  return [
    artifacts.custom({
      name: ".oma/pr-review-summary.md",
      mediaType: "text/markdown",
      content: `${findings.summary}\n`,
    }),
    artifacts.custom({
      name: ".oma/pr-review-findings.json",
      mediaType: "application/json",
      content: `${JSON.stringify(findings, null, 2)}\n`,
    }),
    artifacts.custom({
      name: ".oma/pr-review-findings.md",
      mediaType: "text/markdown",
      content: renderFindingsMarkdown(findings),
    }),
  ];
}

function findingsFromResponse(response: ResponsesBody): ReviewFindingsArtifact {
  const text = outputText(response);
  if (!text) {
    throw new Error("OpenAI review completed without text output.");
  }
  const candidates = [
    text,
    text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, ""),
  ];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as ReviewFindingsArtifact;
    } catch {
      continue;
    }
  }

  throw new Error(`OpenAI review returned invalid JSON: ${text.slice(0, 500)}`);
}

export function openAIReadOnlyReviewHarness(input: OpenAIReviewHarnessInput): Harness {
  return {
    id: "openai-readonly-review",

    async run(harnessInput: HarnessInput) {
      const model = input.model ?? defaultModel;
      const reasoningEffort = input.reasoningEffort ?? defaultReasoningEffort;
      const maxToolRounds = input.maxToolRounds ?? defaultMaxToolRounds;
      const maxReadBytes = input.maxReadBytes ?? defaultMaxReadBytes;
      const maxCommandBytes = input.maxCommandBytes ?? defaultMaxCommandBytes;
      const fetchImpl = input.fetch ?? fetch;
      const conversation: unknown[] = [
        {
          role: "user",
          content: reviewInput(input.context),
        },
      ];

      for (let round = 0; round <= maxToolRounds; round += 1) {
        await harnessInput.observe({
          kind: "state",
          label: "openai-review",
          status: "updated",
          summary: `review round ${String(round + 1)}`,
        });

        const response = await createResponse({
          apiKey: input.apiKey,
          fetchImpl,
          model,
          reasoningEffort,
          conversation,
          allowTools: true,
        });
        const calls = (response.output ?? []).filter(
          (item): item is Extract<ResponsesOutputItem, { type: "function_call" }> =>
            item.type === "function_call",
        );

        if (calls.length === 0) {
          const findings = findingsFromResponse(response);
          return {
            artifacts: findingsArtifacts(findings),
          };
        }

        conversation.push(...(response.output ?? []));
        for (const call of calls) {
          const result = await executeTool({
            environment: harnessInput.environment,
            name: call.name,
            args: assertToolArgs(call.arguments),
            maxReadBytes,
            maxCommandBytes,
          });
          conversation.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: result,
          });
        }
      }

      conversation.push({
        role: "user",
        content:
          "Tool budget exhausted. Return the final JSON review now using only the evidence already gathered. Do not request more tools.",
      });
      const response = await createResponse({
        apiKey: input.apiKey,
        fetchImpl,
        model,
        reasoningEffort,
        conversation,
        allowTools: false,
      });
      const findings = findingsFromResponse(response);
      return {
        artifacts: findingsArtifacts(findings),
      };
    },
  };
}
