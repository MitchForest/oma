import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { runCli } from "../src/index";
import { createOmaApp, loadServerConfig } from "@oma/server";

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oma-cli-"));
  await mkdir(join(dir, ".oma"), { recursive: true });
  return dir;
}

async function writeConfig(dir: string, validation = true): Promise<void> {
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
        session: {
          kind: "jsonl",
          dir: ".oma/sessions",
        },
        validation: validation
          ? [
              {
                kind: "artifactExists",
                path: "report.md",
              },
            ]
          : [],
      },
      null,
      2,
    )}\n`,
  );
}

function runIdFrom(output: string): string {
  return output.split(" ")[0] ?? "";
}

test("init creates committed config and generated state directories", async () => {
  const dir = await workspace();
  const result = await runCli({
    argv: ["init", "--harness", "mock"],
    cwd: dir,
  });

  expect(result).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: "initialized oma.config.json",
  });
  expect(JSON.parse(await readFile(join(dir, "oma.config.json"), "utf8"))).toMatchObject({
    harness: {
      kind: "mock",
    },
  });
  await expect(stat(join(dir, ".oma", "sessions"))).resolves.toBeTruthy();
  await expect(stat(join(dir, ".oma", "runs"))).resolves.toBeTruthy();
  await expect(stat(join(dir, ".oma", "outcomes"))).resolves.toBeTruthy();
});

test("run inspect replay and validate compose the runtime without a UI", async () => {
  const dir = await workspace();
  await writeConfig(dir);

  const runResult = await runCli({
    argv: ["run", "Create the report"],
    cwd: dir,
  });
  expect(runResult.exitCode).toBe(0);
  expect(runResult.stdout).toContain("succeeded");
  const runId = runIdFrom(runResult.stdout);

  const inspectResult = await runCli({
    argv: ["inspect", runId],
    cwd: dir,
  });
  expect(inspectResult.exitCode).toBe(0);
  expect(inspectResult.stdout).toContain(`${runId} succeeded`);
  expect(inspectResult.stdout).toContain("artifacts 1");
  expect(inspectResult.stdout).toContain("validation 1");

  const replayResult = await runCli({
    argv: ["replay", runId],
    cwd: dir,
  });
  expect(replayResult.exitCode).toBe(0);
  expect(replayResult.stdout).toContain(`${runId} succeeded`);

  const validateResult = await runCli({
    argv: ["validate", runId],
    cwd: dir,
  });
  expect(validateResult.exitCode).toBe(0);
  expect(validateResult.stdout).toContain(`${runId} succeeded`);

  const validationReport = JSON.parse(
    await readFile(join(dir, ".oma", "outcomes", `${runId}.validation.json`), "utf8"),
  ) as { validation: unknown[] };
  expect(validationReport.validation).toHaveLength(1);
});

test("local inspectability commands expose runs events artifacts validation and outcome", async () => {
  const dir = await workspace();
  await writeConfig(dir);

  const runResult = await runCli({
    argv: ["run", "Create the report"],
    cwd: dir,
  });
  const runId = runIdFrom(runResult.stdout);

  const runs = await runCli({
    argv: ["runs"],
    cwd: dir,
  });
  expect(runs.stdout).toContain(runId);
  expect(runs.stdout).toContain("Create the report");

  const events = await runCli({
    argv: ["events", runId, "--type", "run.completed"],
    cwd: dir,
  });
  expect(events.stdout).toContain("run.completed");

  const artifacts = await runCli({
    argv: ["artifacts", runId],
    cwd: dir,
  });
  expect(artifacts.stdout).toContain("report.md");

  const artifact = await runCli({
    argv: ["artifact", runId, "report.md"],
    cwd: dir,
  });
  expect(artifact.stdout).toBe("Done.");

  const artifactOutput = await runCli({
    argv: ["artifact", runId, "report.md", "--output", "copied-report.md"],
    cwd: dir,
  });
  expect(artifactOutput.stdout).toBe("copied-report.md");
  expect(await readFile(join(dir, "copied-report.md"), "utf8")).toBe("Done.");

  const validation = await runCli({
    argv: ["validation", runId],
    cwd: dir,
  });
  expect(validation.exitCode).toBe(0);
  expect(validation.stdout).toContain("passed artifact.exists:report.md");

  const outcome = await runCli({
    argv: ["outcome", runId],
    cwd: dir,
  });
  expect(outcome.stdout).toContain(`${runId} succeeded`);

  const watch = await runCli({
    argv: ["watch", runId],
    cwd: dir,
  });
  expect(watch.stdout).toContain("run.started");
  expect(watch.stdout).toContain("run.completed");
});

test("api inspectability commands read server-backed runs", async () => {
  const dir = await workspace();
  await writeConfig(dir);
  const app = await createOmaApp({
    config: await loadServerConfig({
      cwd: dir,
    }),
  });
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  const api = `http://127.0.0.1:${String(server.port)}`;

  try {
    const created = await fetch(`${api}/runs`, {
      body: JSON.stringify({
        objective: {
          goal: "Create the API report",
        },
      }),
      method: "POST",
    });
    const createdBody = (await created.json()) as { runId: string };
    await app.drain();

    const runs = await runCli({
      argv: ["runs", "--api", api],
      cwd: dir,
    });
    expect(runs.stdout).toContain(createdBody.runId);

    const outcome = await runCli({
      argv: ["outcome", createdBody.runId, "--api", api],
      cwd: dir,
    });
    expect(outcome.stdout).toContain(`${createdBody.runId} succeeded`);

    const events = await runCli({
      argv: ["events", createdBody.runId, "--api", api, "--type", "run.completed"],
      cwd: dir,
    });
    expect(events.stdout).toContain("run.completed");

    const artifacts = await runCli({
      argv: ["artifacts", createdBody.runId, "--api", api],
      cwd: dir,
    });
    expect(artifacts.stdout).toContain("report.md");

    const artifact = await runCli({
      argv: ["artifact", createdBody.runId, "report.md", "--api", api],
      cwd: dir,
    });
    expect(artifact.stdout).toBe("Done.");

    const validation = await runCli({
      argv: ["validation", createdBody.runId, "--api", api],
      cwd: dir,
    });
    expect(validation.stdout).toContain("passed artifact.exists:report.md");

    const watch = await runCli({
      argv: ["watch", createdBody.runId, "--api", api],
      cwd: dir,
    });
    expect(watch.stdout).toContain("run.completed");
    expect(watch.stdout).toContain("done succeeded");
  } finally {
    server.stop();
    app.close();
  }
});

test("run exits nonzero when configured validation fails", async () => {
  const dir = await workspace();
  await writeConfig(dir);
  const configPath = join(dir, "oma.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.validation = [
    {
      kind: "artifactExists",
      path: "missing.md",
    },
  ];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = await runCli({
    argv: ["run", "Create the report"],
    cwd: dir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("failed");
});

test("doctor reports valid mock config without requiring provider tools", async () => {
  const dir = await workspace();
  await writeConfig(dir, false);

  const result = await runCli({
    argv: ["doctor", "--json"],
    cwd: dir,
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: true,
  });
});
