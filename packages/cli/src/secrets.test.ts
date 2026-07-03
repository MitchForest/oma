import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveSecretRef, resolveSecretRefs } from "./secrets";

test("env and file refs resolve; failures name the ref, never a value", async () => {
  process.env.OMA_SECRET_TEST = "from-env";
  expect(await resolveSecretRef("token", "env://OMA_SECRET_TEST")).toBe("from-env");
  delete process.env.OMA_SECRET_TEST;

  await expect(resolveSecretRef("token", "env://OMA_SECRET_TEST")).rejects.toThrow(
    "OMA_SECRET_TEST is not set"
  );

  const dir = mkdtempSync(join(tmpdir(), "oma-secret-"));
  const filePath = join(dir, "secret.txt");
  writeFileSync(filePath, "  from-file\n");
  expect(await resolveSecretRef("token", `file://${filePath}`)).toBe("from-file");

  await expect(resolveSecretRef("token", "file:///does/not/exist")).rejects.toThrow(
    "file not readable"
  );

  await expect(resolveSecretRef("token", "vault://nope")).rejects.toThrow(
    'unsupported scheme "vault"'
  );

  process.env.OMA_SECRET_A = "a";
  process.env.OMA_SECRET_B = "b";
  expect(
    await resolveSecretRefs({ A: "env://OMA_SECRET_A", B: "env://OMA_SECRET_B" })
  ).toEqual({ A: "a", B: "b" });
  delete process.env.OMA_SECRET_A;
  delete process.env.OMA_SECRET_B;
});
