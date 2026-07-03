export interface SandboxPolicy {
  kind: string;
  cwd?: string;
  env?: Record<string, string>;
  allowedCommands?: string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  network?: "inherit" | "disabled";
  cleanup?: "always" | "never" | "on-success";
  [key: string]: unknown;
}

export interface SandboxProvisionContext {
  sessionId?: string;
  profileName?: string;
}

export interface SandboxExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface SandboxDestroyOptions {
  outcome?: "success" | "failure";
}

export interface Sandbox {
  id: string;
  policy: SandboxPolicy;
  exec(request: SandboxExecRequest): Promise<SandboxExecResult>;
  destroy(options?: SandboxDestroyOptions): Promise<void>;
}

export interface SandboxProvider {
  provision(policy: SandboxPolicy, context?: SandboxProvisionContext): Promise<Sandbox>;
}

export * from "./helpers";
