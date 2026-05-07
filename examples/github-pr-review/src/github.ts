import type {
  PullRequestContext,
  PullRequestFile,
  ReviewCommentPlan,
  ReviewRequest,
} from "./types";
import { parseReviewLedger } from "./comments";
import { summaryMarker } from "./markers";

export { summaryMarker } from "./markers";

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export type GithubClientInput = {
  token: string;
  fetch?: FetchLike;
  apiUrl?: string;
};

type GithubComment = {
  id: number;
  body?: string;
};

type GithubPullRequest = {
  title?: string;
  body?: string;
  user?: {
    login?: string;
  };
  base?: {
    ref?: string;
    sha?: string;
  };
  head?: {
    ref?: string;
    sha?: string;
  };
};

type ReactionContent = "+1" | "confused" | "eyes";

type CommitStatusState = "error" | "failure" | "pending" | "success";

export type ReviewCommitStatus = {
  state: CommitStatusState;
  description: string;
  targetUrl?: string | undefined;
};

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const message = typeof record.message === "string" ? record.message : response.statusText;
    throw new Error(`GitHub ${label} failed: ${String(response.status)} ${message}`);
  }
  return body as T;
}

export class GithubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly token: string;

  constructor(input: GithubClientInput) {
    this.apiUrl = input.apiUrl ?? "https://api.github.com";
    this.fetchImpl = input.fetch ?? fetch;
    this.token = input.token;
  }

  async request<T>(
    method: string,
    path: string,
    label: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
    });
    return await readJson<T>(response, label);
  }

  async requestText(path: string, label: string, accept: string): Promise<string> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: "GET",
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${label} failed: ${String(response.status)} ${response.statusText}`);
    }
    return await response.text();
  }

  async addReaction(
    request: ReviewRequest,
    commentId: number,
    content: ReactionContent,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.apiUrl}/repos/${request.repository.fullName}/issues/comments/${String(commentId)}/reactions`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github.squirrel-girl-preview+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ content }),
      },
    );
    if (response.status === 422) {
      return;
    }
    await readJson<unknown>(response, "add reaction");
  }

  async addEyesReaction(request: ReviewRequest, commentId: number): Promise<void> {
    await this.addReaction(request, commentId, "eyes");
  }

  async setReviewStatus(request: ReviewRequest, status: ReviewCommitStatus): Promise<void> {
    const sha = request.pullRequest.headSha;
    if (!sha) {
      return;
    }
    const body: {
      state: CommitStatusState;
      context: string;
      description: string;
      target_url?: string;
    } = {
      state: status.state,
      context: "OMA PR Review",
      description: status.description.slice(0, 140),
    };
    if (status.targetUrl) {
      body.target_url = status.targetUrl;
    }
    await this.request(
      "POST",
      `/repos/${request.repository.fullName}/statuses/${sha}`,
      "set commit status",
      {
        body: JSON.stringify(body),
      },
    );
  }

  async fetchPullRequestContext(request: ReviewRequest): Promise<PullRequestContext> {
    const repo = request.repository.fullName;
    const number = String(request.pullRequest.number);
    const pr = await this.request<GithubPullRequest>(
      "GET",
      `/repos/${repo}/pulls/${number}`,
      "pull request",
    );
    const files = await this.request<PullRequestFile[]>(
      "GET",
      `/repos/${repo}/pulls/${number}/files`,
      "pull request files",
    );
    const diff = await this.requestText(
      `/repos/${repo}/pulls/${number}`,
      "pull request diff",
      "application/vnd.github.diff",
    );
    const comments = await this.request<GithubComment[]>(
      "GET",
      `/repos/${repo}/issues/${number}/comments`,
      "issue comments",
    );
    const existingSummary = comments.find((comment) => comment.body?.includes(summaryMarker));

    const context: PullRequestContext = {
      request: {
        ...request,
        pullRequest: {
          ...request.pullRequest,
          headSha: request.pullRequest.headSha || pr.head?.sha || "",
          baseSha: request.pullRequest.baseSha || pr.base?.sha || "",
        },
      },
      title: pr.title ?? "",
      body: pr.body ?? "",
      author: pr.user?.login ?? "",
      baseBranch: pr.base?.ref ?? "",
      headBranch: pr.head?.ref ?? "",
      files,
      diff,
      existingFindingIds: existingSummary?.body ? extractFindingIds(existingSummary.body) : [],
    };
    if (existingSummary) {
      context.existingSummaryCommentId = existingSummary.id;
      const previousLedger = parseReviewLedger(existingSummary.body ?? "");
      if (previousLedger) {
        context.previousLedger = previousLedger;
      }
    }
    return context;
  }

  async upsertSummaryBody(request: ReviewRequest, body: string): Promise<void> {
    const repo = request.repository.fullName;
    const number = String(request.pullRequest.number);
    const comments = await this.request<GithubComment[]>(
      "GET",
      `/repos/${repo}/issues/${number}/comments`,
      "issue comments",
    );
    const existing = comments.find((comment) => comment.body?.includes(summaryMarker));
    if (existing) {
      await this.request(
        "PATCH",
        `/repos/${repo}/issues/comments/${String(existing.id)}`,
        "update summary",
        {
          body: JSON.stringify({ body }),
        },
      );
      return;
    }

    await this.request("POST", `/repos/${repo}/issues/${number}/comments`, "create summary", {
      body: JSON.stringify({ body }),
    });
  }

  async upsertSummary(request: ReviewRequest, plan: ReviewCommentPlan): Promise<void> {
    await this.upsertSummaryBody(request, plan.summary.body);
  }

  async publishInlineReview(request: ReviewRequest, plan: ReviewCommentPlan): Promise<void> {
    if (plan.inline.length === 0) {
      return;
    }

    const comments = plan.inline.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: `${comment.body}\n\n<!-- oma-finding:${comment.findingId} -->`,
    }));

    await this.request(
      "POST",
      `/repos/${request.repository.fullName}/pulls/${String(request.pullRequest.number)}/reviews`,
      "create pull request review",
      {
        body: JSON.stringify({
          event: "COMMENT",
          comments,
        }),
      },
    );
  }
}

export function extractFindingIds(body: string): string[] {
  return [...body.matchAll(/<!--\s*oma-finding:([a-zA-Z0-9._:-]+)\s*-->/g)].map((match) => {
    const id = match[1];
    if (!id) {
      throw new Error("Invalid finding marker.");
    }
    return id;
  });
}

export function commentIdFromGithubEvent(event: unknown): number | undefined {
  const record = assertRecord(event, "event");
  if (!record.comment) {
    return undefined;
  }
  const comment = assertRecord(record.comment, "comment");
  return typeof comment.id === "number" ? comment.id : undefined;
}
