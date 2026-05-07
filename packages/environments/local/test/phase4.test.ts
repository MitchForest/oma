import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  collectors,
  harnesses,
  objective,
  outcomes,
  run,
  sessions,
  validators,
} from "@oma/runtime";
import { localEnvironment } from "../src";

async function gitWorkspace(): Promise<string | undefined> {
  if (spawnSync("git", ["--version"]).status !== 0) {
    return undefined;
  }

  const dir = await mkdtemp(join(tmpdir(), "oma-phase4-"));
  spawnSync("git", ["init"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "oma@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "OMA"], { cwd: dir });
  await writeFile(join(dir, "tracked.txt"), "before\n", "utf8");
  spawnSync("git", ["add", "tracked.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: dir });
  await writeFile(join(dir, "tracked.txt"), "after\n", "utf8");
  return dir;
}

test("file and git diff collectors produce report and patch artifacts", async () => {
  const dir = await gitWorkspace();
  if (!dir) {
    return;
  }

  const outcome = await run({
    objective: objective({
      goal: "Collect artifacts",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        await environment.filesystem?.writeText("report.md", "Done.");

        return {
          artifacts: [
            await collectors.report("report.md").collect({ environment }),
            await collectors.gitDiff("changes.patch").collect({ environment }),
          ],
        };
      }),
    },
    environment: localEnvironment({
      workspace: dir,
    }),
    validation: [validators.artifactExists(["report.md", "changes.patch"])],
  });

  expect(outcome.status).toBe("succeeded");
  expect(outcome.artifacts.map((artifact) => artifact.kind)).toEqual(["report", "patch"]);
  expect(
    outcome.artifacts.find((artifact) => artifact.name === "changes.patch")?.content,
  ).toContain("diff --git");
});

test("directory collector produces a manifest artifact", async () => {
  const dir = await gitWorkspace();
  if (!dir) {
    return;
  }

  const outcome = await run({
    objective: objective({
      goal: "Collect directory manifest",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        await environment.filesystem?.writeText("notes/a.txt", "A");
        await environment.filesystem?.writeText("notes/b.txt", "BB");
        return {
          artifacts: [await collectors.directory("notes").collect({ environment })],
        };
      }),
    },
    environment: localEnvironment({
      workspace: dir,
    }),
  });

  expect(outcome.artifacts[0]?.kind).toBe("directory");
  expect(outcome.artifacts[0]?.content).toContain("notes/a.txt");
  expect(outcome.artifacts[0]?.content).toContain('"bytes": 2');
});

test("local git diff capability returns patch text", async () => {
  const dir = await gitWorkspace();
  if (!dir) {
    return;
  }

  let diff = "";

  await run({
    objective: objective({
      goal: "Get diff",
    }),
    process: {
      session: sessions.ephemeral(),
      harness: harnesses.custom(async ({ environment }) => {
        diff = (await environment.git?.diff()) ?? "";
        return {
          artifacts: [],
        };
      }),
    },
    environment: localEnvironment({
      workspace: dir,
    }),
  });

  expect(diff).toContain("diff --git");
});

test("outcome writer creates inspectable json and markdown files", async () => {
  const dir = await gitWorkspace();
  if (!dir) {
    return;
  }

  const session = sessions.ephemeral();
  const environment = localEnvironment({
    workspace: dir,
  });

  const outcome = await run({
    objective: objective({
      goal: "Write outcome files",
    }),
    process: {
      session,
      harness: harnesses.custom(async ({ environment }) => {
        await environment.filesystem?.writeText("report.md", "Done.");
        return {
          artifacts: [
            await collectors.report("report.md").collect({ environment }),
            await collectors.gitDiff("changes.patch").collect({ environment }),
          ],
        };
      }),
    },
    environment,
    validation: [
      validators.command({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
    ],
  });

  await outcomes.write(outcome, {
    environment,
    session,
    jsonPath: ".oma/outcome.json",
    markdownPath: ".oma/outcome.md",
  });

  const json = JSON.parse(await readFile(join(dir, ".oma/outcome.json"), "utf8")) as {
    schemaVersion: number;
    status: string;
  };
  const markdown = await readFile(join(dir, ".oma/outcome.md"), "utf8");

  expect(json.schemaVersion).toBe(1);
  expect(json.status).toBe("succeeded");
  expect(markdown).toContain("# OMA Outcome");
});
