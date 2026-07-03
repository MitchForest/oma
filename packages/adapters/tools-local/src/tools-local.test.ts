import { mkdtempSync, symlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { indexTools, type AnyTool, type Sandbox, type SandboxExecRequest } from "@oma/core";
import { createLocalTools } from "./index";

test("local tools read, list, search, replace, shell, and test", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));

  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/example.txt"), "hello world\n");

  const tools = indexTools(createLocalTools({ cwd, testCommand: "printf test-ok" }));

  expect(await call(tools.get("read_file")!, { path: "src/example.txt" })).toMatchObject({
    path: "src/example.txt",
    content: "hello world\n"
  });
  expect(await call(tools.get("list_files")!, { maxResults: 10 })).toMatchObject({
    files: ["src/example.txt"]
  });
  expect(await call(tools.get("list_files")!, { pattern: "*.txt", maxResults: 10 })).toMatchObject(
    {
      files: ["src/example.txt"]
    }
  );
  expect(await call(tools.get("search")!, { query: "hello", maxResults: 10 })).toMatchObject({
    count: 1
  });
  expect(
    await call(tools.get("replace_in_file")!, {
      path: "src/example.txt",
      old: "world",
      new: "oma"
    })
  ).toMatchObject({ replacements: 1 });
  expect(await readFile(join(cwd, "src/example.txt"), "utf8")).toBe("hello oma\n");
  expect(await call(tools.get("bash")!, { command: "printf", args: ["shell-ok"] })).toMatchObject({
    stdout: "shell-ok",
    exitCode: 0
  });
  expect(await call(tools.get("run_tests")!, {})).toMatchObject({
    stdout: "test-ok",
    exitCode: 0
  });
});

test("local tools reject paths outside cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const tools = indexTools(createLocalTools({ cwd }));

  await expect(call(tools.get("read_file")!, { path: "../outside" })).rejects.toThrow();
});

test("local tools reject symlink escapes out of cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const outside = mkdtempSync(join(tmpdir(), "oma-tools-outside-"));

  await writeFile(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(cwd, "evil"));
  symlinkSync(join(outside, "secret.txt"), join(cwd, "evil-file"));

  const tools = indexTools(createLocalTools({ cwd }));

  // Reads through a symlinked directory or file must not escape cwd.
  await expect(call(tools.get("read_file")!, { path: "evil/secret.txt" })).rejects.toThrow(
    "escapes root"
  );
  await expect(call(tools.get("read_file")!, { path: "evil-file" })).rejects.toThrow(
    "escapes root"
  );
  // Writes through a symlinked directory (including new files) must not escape.
  await expect(
    call(tools.get("write_file")!, { path: "evil/owned.txt", content: "pwned" })
  ).rejects.toThrow("escapes root");
  await expect(
    call(tools.get("replace_in_file")!, { path: "evil/secret.txt", old: "secret", new: "x" })
  ).rejects.toThrow("escapes root");
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret");
});

test("replace_in_file keeps $-patterns literal and rejects multiple matches", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const tools = indexTools(createLocalTools({ cwd }));

  await writeFile(join(cwd, "code.txt"), "const price = COST;\n");
  await call(tools.get("replace_in_file")!, {
    path: "code.txt",
    old: "COST",
    new: "$&100 + $'"
  });
  expect(await readFile(join(cwd, "code.txt"), "utf8")).toBe("const price = $&100 + $';\n");

  await writeFile(join(cwd, "dupes.txt"), "alpha beta alpha\n");
  await expect(
    call(tools.get("replace_in_file")!, { path: "dupes.txt", old: "alpha", new: "gamma" })
  ).rejects.toThrow("matches more than once");
  expect(await readFile(join(cwd, "dupes.txt"), "utf8")).toBe("alpha beta alpha\n");
});

test("local command tools enforce policy and cap output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const tools = indexTools(
    createLocalTools({
      cwd,
      allowedCommands: ["printf"],
      outputLimitBytes: 12
    })
  );

  await expect(
    call(tools.get("bash")!, { command: "echo", args: ["blocked"] })
  ).rejects.toThrow("not allowed");

  expect(
    await call(tools.get("bash")!, { command: "printf", args: ["abcdefghijklmnop"] })
  ).toMatchObject({
    stdout: "...[truncated]",
    truncated: true
  });
});

test("local command tools do not inherit process env by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  process.env.OMA_SECRET_TEST_VALUE = "leaked";
  const tools = indexTools(createLocalTools({ cwd, allowedCommands: ["bun"] }));

  try {
    expect(
      await call(tools.get("bash")!, {
        command: "bun",
        args: ["--eval", "console.log(process.env.OMA_SECRET_TEST_VALUE ?? 'missing')"]
      })
    ).toMatchObject({ stdout: "missing\n" });
  } finally {
    delete process.env.OMA_SECRET_TEST_VALUE;
  }
});

test("local command tools use only explicitly configured env", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const tools = indexTools(
    createLocalTools({
      cwd,
      allowedCommands: ["bun"],
      env: { OMA_ALLOWED_VALUE: "visible" }
    })
  );

  expect(
    await call(tools.get("bash")!, {
      command: "bun",
      args: ["--eval", "console.log(process.env.OMA_ALLOWED_VALUE ?? 'missing')"]
    })
  ).toMatchObject({ stdout: "visible\n" });
});

test("run_tests enforces allowlist against the configured executable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const tools = indexTools(
    createLocalTools({
      cwd,
      testCommand: "bun --version",
      allowedCommands: ["bun"]
    })
  );

  expect(await call(tools.get("run_tests")!, {})).toMatchObject({
    exitCode: 0
  });
});

test("local command tools use a provided sandbox", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "oma-tools-"));
  const requests: SandboxExecRequest[] = [];
  const sandbox: Sandbox = {
    id: "test-sandbox",
    policy: { kind: "test", cwd },
    exec: async (request) => {
      requests.push(request);
      return {
        exitCode: 0,
        stdout: request.command,
        stderr: "",
        timedOut: false,
        truncated: false
      };
    },
    destroy: async () => {}
  };
  const tools = indexTools(createLocalTools({ cwd, sandbox, testCommand: "bun test" }));

  expect(await call(tools.get("bash")!, { command: "printf", args: ["ok"] })).toMatchObject({
    stdout: "printf"
  });
  expect(await call(tools.get("run_tests")!, {})).toMatchObject({
    stdout: "bun"
  });
  expect(requests.map((request) => request.command)).toEqual(["printf", "bun"]);
});

async function call(tool: AnyTool, args: unknown): Promise<unknown> {
  const parsed = tool.schema ? tool.schema.parse(args) : args;
  return tool.handler(parsed, { sessionId: "test", callId: tool.name });
}
