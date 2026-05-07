import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BoundEnvironment,
  CommandInput,
  CommandObserver,
  CommandResult,
  Environment,
  EnvironmentContext,
  GitStatusResult,
} from "@oma/runtime";

export type LocalEnvironmentOptions = {
  workspace: string;
  defaultTimeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
};

const defaultTimeoutMs = 30_000;
const defaultMaxOutputBytes = 64_000;
const defaultKillGraceMs = 1_000;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) {
    return {
      text,
      truncated: false,
    };
  }

  let end = text.length;
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) {
    end -= 1;
  }

  return {
    text: text.slice(0, end),
    truncated: true,
  };
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function assertInside(root: string, path: string): Promise<string> {
  const rootReal = await realpath(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(rootReal, path);

  if (!isInside(rootReal, target)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }

  return target;
}

async function assertExistingInside(root: string, path: string): Promise<string> {
  const target = await assertInside(root, path);
  const targetReal = await realpath(target);
  const rootReal = await realpath(root);

  if (!isInside(rootReal, targetReal)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }

  return targetReal;
}

async function assertWritableInside(root: string, path: string): Promise<string> {
  const target = await assertInside(root, path);
  const parent = dirname(target);
  const rootReal = await realpath(root);

  if (!isInside(rootReal, parent)) {
    throw new Error(`Path escapes workspace: ${path}`);
  }

  await mkdir(parent, { recursive: true });

  // This check prevents accidental workspace escapes. The local environment is
  // explicitly not a security boundary and cannot prevent malicious TOCTOU races.
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const targetReal = await realpath(target);
      if (!isInside(rootReal, targetReal)) {
        throw new Error(`Path escapes workspace: ${path}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  return target;
}

function displayPath(workspace: string, path: string): string {
  const relation = relative(workspace, path);
  return relation === "" ? "." : relation.split(sep).join("/");
}

export function localEnvironment(options: LocalEnvironmentOptions): Environment {
  const workspace = resolve(options.workspace);
  const timeoutMs = options.defaultTimeoutMs ?? defaultTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
  const killGraceMs = options.killGraceMs ?? defaultKillGraceMs;

  return {
    kind: "local",
    capabilities: {
      filesystem: true,
      git: true,
      securityBoundary: false,
      shell: true,
    },

    bind(context: EnvironmentContext): BoundEnvironment {
      const append = context.session.append.bind(context.session);

      async function exec(input: CommandInput, observer?: CommandObserver): Promise<CommandResult> {
        const args = input.args ?? [];
        const cwd = input.cwd
          ? await assertExistingInside(workspace, input.cwd)
          : await realpath(workspace);
        const commandTimeoutMs = input.timeoutMs ?? timeoutMs;
        const startedAt = Date.now();

        await append({
          runId: context.runId,
          type: "environment.command.started",
          at: new Date().toISOString(),
          data: {
            command: input.command,
            args,
            cwd,
            timeoutMs: commandTimeoutMs,
          },
        });

        return await new Promise<CommandResult>((resolveResult) => {
          const child = spawn(input.command, args, {
            cwd,
            shell: false,
          });
          let stdout = {
            text: "",
            truncated: false,
          };
          let stderr = {
            text: "",
            truncated: false,
          };
          let timedOut = false;
          let settled = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;

          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              if (!settled) {
                child.kill("SIGKILL");
              }
            }, killGraceMs);
          }, commandTimeoutMs);

          child.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            void observer?.stdout?.(text);
            stdout = truncate(`${stdout.text}${text}`, maxOutputBytes);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            void observer?.stderr?.(text);
            stderr = truncate(`${stderr.text}${text}`, maxOutputBytes);
          });

          if (input.stdin !== undefined) {
            child.stdin.end(input.stdin);
          } else {
            child.stdin.end();
          }

          child.on("error", (error) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);
            if (killTimer) {
              clearTimeout(killTimer);
            }
            const durationMs = Date.now() - startedAt;

            void append({
              runId: context.runId,
              type: "environment.command.failed",
              at: new Date().toISOString(),
              data: {
                command: input.command,
                message: error.message,
                durationMs,
              },
            }).then(() => {
              resolveResult({
                command: input.command,
                args,
                cwd,
                durationMs,
                exitCode: null,
                stderr: error.message,
                stdout: "",
                timedOut: false,
                truncated: {
                  stderr: false,
                  stdout: false,
                },
              });
            });
          });

          child.on("close", (exitCode) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);
            if (killTimer) {
              clearTimeout(killTimer);
            }

            const durationMs = Date.now() - startedAt;

            const events = [];

            if (stdout.text.length > 0 || stdout.truncated) {
              events.push(
                append({
                  runId: context.runId,
                  type: "environment.command.output",
                  at: new Date().toISOString(),
                  data: {
                    command: input.command,
                    stream: "stdout",
                    text: stdout.text,
                    truncated: stdout.truncated,
                  },
                }),
              );
            }

            if (stderr.text.length > 0 || stderr.truncated) {
              events.push(
                append({
                  runId: context.runId,
                  type: "environment.command.output",
                  at: new Date().toISOString(),
                  data: {
                    command: input.command,
                    stream: "stderr",
                    text: stderr.text,
                    truncated: stderr.truncated,
                  },
                }),
              );
            }

            if (timedOut) {
              events.push(
                append({
                  runId: context.runId,
                  type: "environment.command.timed_out",
                  at: new Date().toISOString(),
                  data: {
                    command: input.command,
                    durationMs,
                    timeoutMs: commandTimeoutMs,
                  },
                }),
              );
            }

            events.push(
              append({
                runId: context.runId,
                type: "environment.command.exited",
                at: new Date().toISOString(),
                data: {
                  command: input.command,
                  durationMs,
                  exitCode,
                },
              }),
            );

            void Promise.all(events).then(() => {
              resolveResult({
                command: input.command,
                args,
                cwd,
                durationMs,
                exitCode,
                stderr: stderr.text,
                stdout: stdout.text,
                timedOut,
                truncated: {
                  stderr: stderr.truncated,
                  stdout: stdout.truncated,
                },
              });
            });
          });
        });
      }

      return {
        kind: "local",
        capabilities: {
          filesystem: true,
          git: true,
          securityBoundary: false,
          shell: true,
        },
        filesystem: {
          async list(path: string): Promise<Array<{ path: string; bytes: number }>> {
            const root = await assertExistingInside(workspace, path);
            const workspaceReal = await realpath(workspace);
            const files: Array<{ path: string; bytes: number }> = [];

            async function walk(current: string): Promise<void> {
              const entries = await readdir(current, { withFileTypes: true });

              for (const entry of entries) {
                const next = resolve(current, entry.name);
                const nextReal = await realpath(next);
                if (!isInside(workspaceReal, nextReal)) {
                  throw new Error(`Path escapes workspace: ${next}`);
                }

                if (entry.isDirectory()) {
                  await walk(nextReal);
                } else if (entry.isFile()) {
                  const metadata = await stat(nextReal);
                  files.push({
                    path: displayPath(workspaceReal, nextReal),
                    bytes: metadata.size,
                  });
                }
              }
            }

            await walk(root);
            return files.sort((left, right) => left.path.localeCompare(right.path));
          },

          async readText(path: string): Promise<string> {
            const target = await assertExistingInside(workspace, path);
            const content = await readFile(target, "utf8");

            await append({
              runId: context.runId,
              type: "environment.filesystem.read",
              at: new Date().toISOString(),
              data: {
                path: displayPath(await realpath(workspace), target),
                bytes: byteLength(content),
              },
            });

            return content;
          },

          async writeText(path: string, content: string): Promise<void> {
            const target = await assertWritableInside(workspace, path);
            await writeFile(target, content, "utf8");

            await append({
              runId: context.runId,
              type: "environment.filesystem.wrote",
              at: new Date().toISOString(),
              data: {
                path: displayPath(await realpath(workspace), target),
                bytes: byteLength(content),
              },
            });
          },
        },
        git: {
          async diff(): Promise<string> {
            const result = await exec({
              command: "git",
              args: ["diff", "--binary"],
            });
            return result.stdout;
          },

          async status(): Promise<GitStatusResult> {
            const result = await exec({
              command: "git",
              args: ["status", "--short"],
            });
            const short = result.stdout.trim();
            const status = {
              clean: short.length === 0,
              short,
            };

            await append({
              runId: context.runId,
              type: "environment.git.status",
              at: new Date().toISOString(),
              data: status,
            });

            return status;
          },
        },
        shell: {
          exec,
        },
      };
    },
  };
}
