import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { artifacts, objective, run } from "@oma/runtime";
import {
  createEnvironment,
  createHarness,
  createSessionStore,
  createValidators,
  defaultProjectConfig,
  listRunRecords,
  loadProject,
  localEvents,
  localOutcome,
  outcomeJsonPath,
  parseProjectConfig,
  readRunRecord,
  validationReportPath,
  writeOutcomeFiles,
  writeRunRecord,
} from "@oma/project";

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oma-project-"));
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
        session: {
          kind: "jsonl",
          dir: ".oma/sessions",
        },
        validation: [
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

test("project config parser validates the shared config shape", () => {
  expect(defaultProjectConfig({ harness: "mock" })).toMatchObject({
    harness: {
      kind: "mock",
    },
  });
  expect(() => parseProjectConfig({ schemaVersion: 1 })).toThrow("workspace is required");
});

test("project factories can construct runtime dependencies", async () => {
  const dir = await workspace();
  const project = await loadProject({ cwd: dir });

  const session = await createSessionStore(project).create();
  const outcome = await run({
    objective: objective({ goal: "Create report" }),
    process: {
      session,
      harness: createHarness(project),
    },
    environment: createEnvironment(project),
    validation: createValidators(project),
  });

  expect(outcome.status).toBe("succeeded");
  expect(outcome.artifacts[0]?.name).toBe("report.md");
});

test("project paths and run index helpers are shared", async () => {
  const dir = await workspace();
  const project = await loadProject({ cwd: dir });

  expect(outcomeJsonPath(project, "run_1")).toEndWith(join(".oma", "outcomes", "run_1.json"));
  expect(validationReportPath(project, "run_1")).toEndWith(
    join(".oma", "outcomes", "run_1.validation.json"),
  );

  await writeRunRecord(project, {
    schemaVersion: 1,
    runId: "run_1",
    sessionId: "session_1",
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    objective: "Done",
    outcomeJsonPath: ".oma/outcomes/run_1.json",
    outcomeMarkdownPath: ".oma/outcomes/run_1.md",
  });

  expect(await readRunRecord(project, "run_1")).toMatchObject({
    runId: "run_1",
  });
  expect(await listRunRecords(project)).toHaveLength(1);
});

test("project inspection helpers replay local outcomes", async () => {
  const dir = await workspace();
  const project = await loadProject({ cwd: dir });
  const session = await createSessionStore(project).create();
  const outcome = await run({
    objective: objective({ goal: "Create report" }),
    process: {
      session,
      harness: createHarness(project),
    },
    environment: createEnvironment(project),
    validation: createValidators(project),
  });

  await writeOutcomeFiles(project, outcome);

  expect((await localOutcome(project, outcome.runId)).status).toBe("succeeded");
  expect(await localEvents(project, outcome.runId)).toHaveLength(outcome.events.length);
  expect(await readFile(outcomeJsonPath(project, outcome.runId), "utf8")).toContain(outcome.runId);
});

test("artifact summaries are content-free", async () => {
  const { artifactSummary } = await import("@oma/project");
  expect(artifactSummary(artifacts.report("report.md", "Done."))).toMatchObject({
    name: "report.md",
    size: 5,
  });
});
