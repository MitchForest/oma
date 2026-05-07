import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createOmaApp, loadServerConfig } from "@oma/server";

async function workspace(input: { validation?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oma-server-"));
  await mkdir(join(dir, ".oma"), { recursive: true });
  await writeFile(
    join(dir, "oma.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workspace: ".",
        harness: {
          kind: "mock",
          options: {
            artifacts: [
              {
                name: "report.md",
                content: "Done.",
              },
            ],
          },
        },
        validation:
          input.validation === false
            ? []
            : [
                {
                  kind: "artifactExists",
                  path: "report.md",
                },
              ],
      },
      null,
      2,
    )}\n`,
  );
  return dir;
}

async function rewriteValidation(dir: string, validation: unknown[]): Promise<void> {
  const path = join(dir, "oma.config.json");
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  config.validation = validation;
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

async function appFor(dir: string, autoStartWorker = true) {
  return await createOmaApp({
    config: await loadServerConfig({
      cwd: dir,
    }),
    autoStartWorker,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function createRun(app: Awaited<ReturnType<typeof appFor>>): Promise<string> {
  const response = await app.fetch(
    new Request("http://oma.test/runs", {
      body: JSON.stringify({
        objective: {
          goal: "Produce a report",
        },
      }),
      method: "POST",
    }),
  );
  expect(response.status).toBe(202);
  const body = await json(response);
  expect(body.status).toBe("queued");
  return body.runId as string;
}

test("server creates runs and exposes outcome artifacts and events", async () => {
  const dir = await workspace();
  const app = await appFor(dir);

  const runId = await createRun(app);
  await app.drain();

  const run = await json(await app.fetch(new Request(`http://oma.test/runs/${runId}`)));
  expect(run.status).toBe("succeeded");

  const events = await json(await app.fetch(new Request(`http://oma.test/runs/${runId}/events`)));
  expect((events.events as unknown[]).length).toBeGreaterThan(0);

  const outcome = await json(await app.fetch(new Request(`http://oma.test/runs/${runId}/outcome`)));
  expect(outcome.status).toBe("succeeded");

  const artifacts = await json(
    await app.fetch(new Request(`http://oma.test/runs/${runId}/artifacts`)),
  );
  const artifact = (artifacts.artifacts as Array<{ id: string; name: string }>)[0];
  expect(artifact?.name).toBe("report.md");

  const artifactResponse = await app.fetch(
    new Request(`http://oma.test/runs/${runId}/artifacts/${artifact?.id ?? ""}`),
  );
  expect(await artifactResponse.text()).toBe("Done.");

  app.close();
});

test("server can restart without losing run state", async () => {
  const dir = await workspace();
  const first = await appFor(dir);
  const runId = await createRun(first);
  await first.drain();
  first.close();

  const second = await appFor(dir);
  const list = await json(await second.fetch(new Request("http://oma.test/runs")));
  expect((list.runs as Array<{ runId: string }>).some((run) => run.runId === runId)).toBe(true);
  second.close();
});

test("server reruns validation without rerunning the harness", async () => {
  const dir = await workspace();
  const app = await appFor(dir);
  const runId = await createRun(app);
  await app.drain();

  const response = await app.fetch(
    new Request(`http://oma.test/runs/${runId}/validate`, {
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  const report = await json(response);
  expect(report.status).toBe("succeeded");
  expect((report.validation as unknown[]).length).toBe(1);
  expect(
    await readFile(join(dir, ".oma", "outcomes", `${runId}.validation.json`), "utf8"),
  ).toContain("artifact.exists:report.md");

  app.close();
});

test("server records failed validation as a failed run", async () => {
  const dir = await workspace();
  await rewriteValidation(dir, [
    {
      kind: "artifactExists",
      path: "missing.md",
    },
  ]);
  const app = await appFor(dir);
  const runId = await createRun(app);
  await app.drain();

  const run = await json(await app.fetch(new Request(`http://oma.test/runs/${runId}`)));
  expect(run.status).toBe("failed");

  const outcome = await json(await app.fetch(new Request(`http://oma.test/runs/${runId}/outcome`)));
  expect(outcome.status).toBe("failed");
  app.close();
});

test("queued runs can be cancelled before the worker claims them", async () => {
  const dir = await workspace();
  const app = await appFor(dir, false);
  const runId = await createRun(app);

  const response = await app.fetch(
    new Request(`http://oma.test/runs/${runId}/cancel`, {
      method: "POST",
    }),
  );

  expect(response.status).toBe(200);
  expect((await json(response)).status).toBe("cancelled");
  app.close();
});

test("event stream sends stored events", async () => {
  const dir = await workspace();
  const app = await appFor(dir);
  const runId = await createRun(app);
  await app.drain();

  const response = await app.fetch(new Request(`http://oma.test/runs/${runId}/events/stream`));
  const body = await response.text();

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(body).toContain("event: oma.event");
  app.close();
});

test("event stream follows a live run until terminal status", async () => {
  const dir = await workspace();
  await rewriteValidation(dir, [
    {
      kind: "command",
      command: "bun",
      args: ["-e", "await new Promise((resolve) => setTimeout(resolve, 50))"],
    },
  ]);
  const app = await appFor(dir);
  const runId = await createRun(app);

  const response = await app.fetch(new Request(`http://oma.test/runs/${runId}/events/stream`));
  const body = await response.text();

  expect(body).toContain("event: oma.event");
  expect(body).toContain("event: oma.done");
  app.close();
});
