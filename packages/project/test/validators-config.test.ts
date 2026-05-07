import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { createValidators, loadProject } from "@oma/project";

test("project config maps optional validator implementations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oma-validators-config-"));
  await mkdir(join(dir, ".oma"), { recursive: true });
  await writeFile(
    join(dir, "oma.config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      workspace: ".",
      harness: { kind: "mock" },
      validation: [
        { kind: "test", command: "bun", args: ["test"] },
        { kind: "typecheck", command: "bun", args: ["run", "typecheck"] },
        { kind: "lint", command: "bun", args: ["run", "lint"] },
        { kind: "gitDiff", required: false },
        {
          kind: "schema",
          artifact: "result.json",
          schema: { type: "object", required: ["status"] },
        },
        {
          kind: "all",
          id: "quality",
          validators: [{ kind: "artifactExists", path: "report.md" }],
        },
      ],
    })}\n`,
  );

  expect(
    createValidators(await loadProject({ cwd: dir })).map((validator) => validator.id),
  ).toEqual([
    "test:bun test",
    "typecheck:bun run typecheck",
    "lint:bun run lint",
    "git.diff:allowed",
    "schema:result.json",
    "quality",
  ]);
});
