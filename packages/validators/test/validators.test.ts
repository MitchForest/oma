import { expect, test } from "bun:test";
import { artifacts, environments, sessions } from "@oma/runtime";
import { validators, formatValidationSummary } from "@oma/validators";
import type { Artifact, BoundEnvironment, CommandInput, CommandResult } from "@oma/runtime";

const objective = {
  goal: "Validate",
  constraints: [],
  success: [],
};

function baseInput(environment: BoundEnvironment, extraArtifacts: Artifact[] = []) {
  return {
    objective,
    artifacts: extraArtifacts,
    environment,
    session: sessions.ephemeral(),
  };
}

function shellEnvironment(result: Partial<CommandResult> = {}): BoundEnvironment {
  return {
    kind: "test",
    capabilities: {
      securityBoundary: false,
      shell: true,
    },
    shell: {
      async exec(input: CommandInput): Promise<CommandResult> {
        return {
          args: input.args ?? [],
          command: input.command,
          cwd: ".",
          durationMs: 1,
          exitCode: 0,
          stderr: "",
          stdout: "",
          timedOut: false,
          truncated: {
            stderr: false,
            stdout: false,
          },
          ...result,
        };
      },
    },
  };
}

test("artifact and command validators preserve existing deterministic behavior", async () => {
  const artifactResult = await validators
    .artifactExists("report.md")
    .validate(
      baseInput(environments.none().bind({ runId: "run_test", session: sessions.ephemeral() }), [
        artifacts.report("report.md", "Done."),
      ]),
    );
  expect(artifactResult.status).toBe("passed");

  const commandResult = await validators
    .command({ command: "bun", args: ["test"] })
    .validate(baseInput(shellEnvironment()));
  expect(commandResult).toMatchObject({
    status: "passed",
    validatorId: "command:bun test",
  });
});

test("test typecheck and lint validators use semantic ids", async () => {
  await expect(
    validators.test({ command: "bun", args: ["test"] }).validate(baseInput(shellEnvironment())),
  ).resolves.toMatchObject({ validatorId: "test:bun test" });
  await expect(
    validators
      .typecheck({ command: "bun", args: ["run", "typecheck"] })
      .validate(baseInput(shellEnvironment())),
  ).resolves.toMatchObject({ validatorId: "typecheck:bun run typecheck" });
  await expect(
    validators
      .lint({ command: "bun", args: ["run", "lint"] })
      .validate(baseInput(shellEnvironment())),
  ).resolves.toMatchObject({ validatorId: "lint:bun run lint" });
});

test("schema validator reports path-specific failures", async () => {
  const validator = validators.schema({
    artifact: "result.json",
    schema: {
      type: "object",
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: ["ok"],
        },
      },
    },
  });

  const result = await validator.validate(
    baseInput(environments.none().bind({ runId: "run_test", session: sessions.ephemeral() }), [
      artifacts.custom({
        name: "result.json",
        mediaType: "application/json",
        content: JSON.stringify({ status: "bad" }),
      }),
    ]),
  );

  expect(result.status).toBe("failed");
  expect(result.evidence[0]?.kind === "text" ? result.evidence[0].message : "").toContain(
    "$.status",
  );
});

test("git diff validator can require or reject diffs", async () => {
  const environment: BoundEnvironment = {
    kind: "test",
    capabilities: {
      git: true,
      securityBoundary: false,
    },
    git: {
      async diff() {
        return "diff --git a/file b/file";
      },
      async status() {
        return { clean: false, short: "M file" };
      },
    },
  };

  await expect(
    validators.gitDiff({ required: true }).validate(baseInput(environment)),
  ).resolves.toMatchObject({
    status: "passed",
  });
  await expect(
    validators.gitDiff({ allowDirty: false }).validate(baseInput(environment)),
  ).resolves.toMatchObject({
    status: "failed",
  });
});

test("composition preserves child evidence", async () => {
  const result = await validators
    .all("quality", [
      validators.command({ command: "bun", args: ["test"] }),
      validators.command({ command: "bun", args: ["lint"], success: () => false }),
    ])
    .validate(baseInput(shellEnvironment()));

  expect(result.status).toBe("failed");
  expect(formatValidationSummary([result]).join("\n")).toContain("command:bun lint");
});
