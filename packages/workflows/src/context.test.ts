import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildContextPack,
  codemap,
  contextPackEvent,
  findStaleContextFiles,
  renderContextSection
} from "./context";
import { workflowContextSchema } from "./schema";

function fixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-context-"));

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "src/auth.ts"),
    [
      "import { db } from './db';",
      "",
      "export interface Session {",
      "  id: string;",
      "  userId: string;",
      "}",
      "",
      "export async function createSession(userId: string): Promise<Session> {",
      "  const id = crypto.randomUUID();",
      "  await db.insert('sessions', { id, userId });",
      "  return { id, userId };",
      "}",
      "",
      "function internalHelper() {",
      "  return 42;",
      "}",
      ""
    ].join("\n")
  );
  writeFileSync(join(dir, "src/auth.test.ts"), "test('x', () => {});\n");
  writeFileSync(
    join(dir, "src/big.ts"),
    `export const table = [\n${'  "row",\n'.repeat(400)}];\n`
  );
  writeFileSync(
    join(dir, "docs/notes.md"),
    "# Notes\n\nSome prose here.\n\n## Design\n\nMore prose.\n"
  );

  return dir;
}

test("selection is sorted, excluded, hashed, and mapped deterministically", async () => {
  const cwd = fixtureTree();
  const context = workflowContextSchema.parse({
    include: ["src/**", "docs/**"],
    exclude: ["**/*.test.ts"],
    map: ["docs/**"]
  });

  const pack = await buildContextPack(context, { cwd });

  expect(pack.files.map((file) => `${file.path}:${file.mode}`)).toEqual([
    "docs/notes.md:map",
    "src/auth.ts:full",
    "src/big.ts:full"
  ]);
  expect(pack.files.every((file) => file.hash.length === 64)).toBe(true);
  expect(pack.dropped).toEqual([]);

  // Same tree, same pack id; changed file, new id.
  const again = await buildContextPack(context, { cwd });
  expect(again.packId).toBe(pack.packId);

  writeFileSync(join(cwd, "src/auth.ts"), "export const changed = true;\n");
  const changed = await buildContextPack(context, { cwd });
  expect(changed.packId).not.toBe(pack.packId);

  // Freshness: the original pack's hashes no longer match the tree.
  const stale = await findStaleContextFiles(pack.files, cwd);
  expect(stale).toEqual([{ path: "src/auth.ts", reason: "changed" }]);
});

test("budget fitting demotes largest-first, then drops, and records why", async () => {
  const cwd = fixtureTree();
  const context = workflowContextSchema.parse({
    include: ["src/**"],
    exclude: ["**/*.test.ts"]
  });

  const unbudgeted = await buildContextPack(context, { cwd });
  const bigFull = unbudgeted.files.find((file) => file.path === "src/big.ts")!;
  const authFull = unbudgeted.files.find((file) => file.path === "src/auth.ts")!;

  // Budget below full total but with room for auth full + big as codemap:
  // big.ts (the largest) demotes, auth.ts stays full.
  const demoting = await buildContextPack(
    workflowContextSchema.parse({
      include: ["src/**"],
      exclude: ["**/*.test.ts"],
      budget: authFull.tokens + Math.ceil(bigFull.tokens / 2)
    }),
    { cwd }
  );

  expect(demoting.files.find((file) => file.path === "src/big.ts")).toMatchObject({
    mode: "map",
    demoted: true
  });
  expect(demoting.files.find((file) => file.path === "src/auth.ts")).toMatchObject({
    mode: "full"
  });
  expect(demoting.totalTokens).toBeLessThanOrEqual(demoting.budget!);

  // A budget nothing fits under drops files with the reason recorded.
  const dropping = await buildContextPack(
    workflowContextSchema.parse({
      include: ["src/**"],
      exclude: ["**/*.test.ts"],
      budget: 10
    }),
    { cwd }
  );

  expect(dropping.files).toEqual([]);
  expect(dropping.dropped.length).toBeGreaterThan(0);
  expect(dropping.dropped[0]!.reason).toContain("over budget");

  const event = contextPackEvent(demoting);
  expect(event.type).toBe("context.pack.built");
  expect(event.files.find((file) => file.path === "src/big.ts")).toMatchObject({
    demoted: true,
    mode: "map"
  });
});

test("codemaps keep signatures and headings, not bodies", () => {
  const tsMap = codemap("auth.ts", [
    "export interface Session {",
    "  id: string;",
    "}",
    "export async function createSession(userId: string): Promise<Session> {",
    "  const secret = 'do-not-show';",
    "  return null as never;",
    "}"
  ].join("\n"));

  expect(tsMap).toContain("export interface Session { … }");
  expect(tsMap).toContain("export async function createSession(userId: string): Promise<Session> { … }");
  expect(tsMap).not.toContain("do-not-show");

  const mdMap = codemap("notes.md", "# Title\n\nbody prose\n\n## Section\n\nmore\n");
  expect(mdMap).toContain("# Title");
  expect(mdMap).toContain("## Section");
  expect(mdMap).not.toContain("body prose");

  const fallback = codemap("data.txt", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  expect(fallback).toContain("line 0");
  expect(fallback).toContain("… (18 more lines)");
});

test("rendered sections carry path, mode, and hash prefix", async () => {
  const cwd = fixtureTree();
  const pack = await buildContextPack(
    workflowContextSchema.parse({ include: ["docs/**"], map: ["docs/**"] }),
    { cwd }
  );
  const section = renderContextSection(pack);

  expect(section).toStartWith("<context>");
  expect(section).toContain('<file path="docs/notes.md" mode="map"');
  expect(section).toContain("# Notes");
  expect(section).toEndWith("</context>");
});
