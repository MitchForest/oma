import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { sentrySignature } from "@oma/adapter-trigger-sentry";

const cliPath = resolve("packages/cli/src/index.ts");

test("fresh repo: templates list, install, validate, and the skill installs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-fresh-"));
  writeFileSync(join(cwd, "README.md"), "# Fresh repo\n\nNothing here yet.\n");

  const listed = await runCli(cwd, ["templates", "--json"]);
  const templates = JSON.parse(listed.stdout) as Array<{ name: string; trigger: string }>;

  expect(templates.map((template) => template.name)).toEqual([
    "build-feature",
    "incident-to-pr",
    "issue-to-pr",
    "nightly-triage",
    "pr-review"
  ]);
  expect(templates.find((template) => template.name === "pr-review")!.trigger).toBe(
    "github:pull_request.opened"
  );

  // Every template installs valid out of the box.
  for (const template of templates) {
    const installed = await runCli(cwd, ["init", "--template", template.name]);

    expect(installed.stdout).toContain(`valid ${template.name}`);
    expect(await Bun.file(join(cwd, `.oma/workflows/${template.name}.yml`)).exists()).toBe(true);
  }

  const dryRun = await runCli(cwd, [
    "trigger",
    "emit",
    "pr-review",
    "github",
    "pull_request.opened",
    "--payload",
    JSON.stringify({ repo: "o/r", pr: 1, draft: false, head: "sha" }),
    "--no-wake",
    "--json"
  ]);

  expect(JSON.parse(dryRun.stdout).route).toEqual({
    type: "spawned",
    sessionId: "review:o/r#1"
  });

  // nightly-triage smoke-runs to completion on the offline fake model, with
  // its context pack recorded.
  const run = await runCli(cwd, ["run", "nightly-triage", "--json"]);
  const output = JSON.parse(run.stdout);

  expect(output.status).toBe("completed");
  expect(
    (output.events as Array<{ type: string }>).some(
      (event) => event.type === "context.pack.built"
    )
  ).toBe(true);

  const skill = await runCli(cwd, ["skill", "install"]);
  expect(skill.stdout).toContain("installed .claude/skills/oma/SKILL.md");

  const skillText = await Bun.file(join(cwd, ".claude/skills/oma/SKILL.md")).text();
  expect(skillText).toContain("name: oma");
  expect(skillText).toContain("oma init --template");
});

test("sentry webhooks route into the installed incident template by session key", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-sentry-"));
  mkdirSync(join(cwd, ".oma"), { recursive: true });
  writeFileSync(
    join(cwd, ".oma/config.json"),
    JSON.stringify({ store: { kind: "sqlite", path: ".oma/sessions.sqlite" }, model: { kind: "fake" } })
  );

  await runCli(cwd, ["init", "--template", "incident-to-pr"]);

  const secret = "sentry-secret";
  const proc = Bun.spawn(
    ["bun", cliPath, "serve", "webhooks", "--port", "0", "--sentry-secret", secret],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_WEBHOOK_SECRET: "x" } }
  );

  try {
    const url = await readServerUrl(proc.stdout);
    const body = JSON.stringify({
      action: "created",
      data: {
        issue: {
          id: "31337",
          title: "TypeError in checkout",
          culprit: "billing/cart.ts",
          permalink: "https://sentry.io/i/31337",
          project: { slug: "web" }
        }
      }
    });

    const unsigned = await fetch(`${url}/webhooks/sentry`, {
      method: "POST",
      headers: { "sentry-hook-resource": "issue" },
      body
    });
    expect(unsigned.status).toBe(400);

    const signed = await fetch(`${url}/webhooks/sentry`, {
      method: "POST",
      headers: {
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": sentrySignature(body, secret),
        "request-id": "req-9"
      },
      body
    });
    const result = (await signed.json()) as {
      signal: { source: string; kind: string };
      result: { workflow: string; route: { type: string; sessionId: string } };
    };

    expect(signed.status).toBe(200);
    expect(result.signal).toMatchObject({ source: "sentry", kind: "issue.created" });
    // Sentry incident -> one durable session keyed by issue id, through the
    // installed template. (Stage outcomes need a real model; routing and
    // identity are what this asserts.)
    expect(result.result).toMatchObject({
      workflow: "incident-to-pr",
      route: { type: "spawned", sessionId: "incident:31337" }
    });
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);

async function readServerUrl(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = /webhooks listening on (\S+)/.exec(buffer);

    if (match) {
      return match[1]!;
    }
  }

  throw new Error(`Server did not print its URL. Output: ${buffer}`);
}

async function runCli(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);

  if (exitCode !== 0) {
    throw new Error(`CLI failed: ${stderr || stdout}`);
  }

  return { stdout, stderr, exitCode };
}
