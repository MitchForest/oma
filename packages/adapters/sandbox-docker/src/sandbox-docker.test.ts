import { expect, test } from "bun:test";
import { runSandboxProviderContractTests } from "@oma/core";
import { DockerSandboxProvider } from "./index";

const image = process.env.OMA_DOCKER_IMAGE;
const dockerAvailable =
  Boolean(image) &&
  Bun.spawnSync(["docker", "version"], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  }).exitCode === 0;

if (dockerAvailable && image) {
  runSandboxProviderContractTests(
    "DockerSandboxProvider",
    () => new DockerSandboxProvider(),
    () => ({
      kind: "docker",
      image,
      allowedCommands: ["sh"],
      cleanup: "always"
    })
  );

  test("DockerSandbox becomes unusable after an exec timeout", async () => {
    const sandbox = await new DockerSandboxProvider().provision({
      kind: "docker",
      image,
      cleanup: "always"
    });

    try {
      const result = await sandbox.exec({
        command: "sh",
        args: ["-c", "sleep 10"],
        timeoutMs: 500
      });

      expect(result.timedOut).toBe(true);
      await expect(sandbox.exec({ command: "sh", args: ["-c", "echo hi"] })).rejects.toThrow(
        "unusable"
      );
    } finally {
      await sandbox.destroy();
    }
  }, 30_000);

  test("DockerSandbox disables network when policy says so", async () => {
    const sandbox = await new DockerSandboxProvider().provision({
      kind: "docker",
      image,
      network: "disabled",
      cleanup: "always"
    });

    try {
      // With --network none the container gets no eth0 (the kernel may still
      // expose other virtual interfaces, e.g. under Docker Desktop).
      const result = await sandbox.exec({
        command: "sh",
        args: ["-c", "ls /sys/class/net"]
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("eth0");
      expect(result.stdout).toContain("lo");
    } finally {
      await sandbox.destroy();
    }
  }, 30_000);
} else {
  test("DockerSandboxProvider contract tests are gated by OMA_DOCKER_IMAGE and Docker", () => {
    expect(dockerAvailable).toBe(false);
  });
}
