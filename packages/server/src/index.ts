import { loadProject } from "@oma/project";
import { createOmaApp } from "./app";
import type { OmaApp } from "./app";

export type { OmaApp };
export { createOmaApp };
export { loadProject as loadServerConfig };

export type OmaServer = OmaApp & {
  start(): void;
  stop(): void;
  url: string;
};

export async function createOmaServer(input: {
  cwd?: string;
  configPath?: string;
  port?: number;
  hostname?: string;
}): Promise<OmaServer> {
  const cwd = input.cwd ?? process.cwd();
  const config = input.configPath
    ? await loadProject({
        cwd,
        configPath: input.configPath,
      })
    : await loadProject({
        cwd,
      });
  const app = await createOmaApp({
    config,
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  const port = input.port ?? 4317;
  const hostname = input.hostname ?? "127.0.0.1";

  return {
    ...app,
    url: `http://${hostname}:${String(port)}`,

    start() {
      server = Bun.serve({
        fetch: app.fetch,
        hostname,
        port,
      });
    },

    stop() {
      server?.stop();
      app.close();
    },
  };
}
