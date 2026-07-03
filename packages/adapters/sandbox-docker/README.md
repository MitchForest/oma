# @oma/adapter-sandbox-docker

Docker CLI-backed sandbox adapter.

```json
{
  "kind": "docker",
  "image": "oven/bun:1",
  "workdir": "/workspace",
  "mount": ".",
  "mountMode": "ro",
  "memory": "2g",
  "pidsLimit": 512,
  "network": "disabled",
  "cleanup": "always",
  "allowedCommands": ["bun", "git", "rg"]
}
```

The adapter starts a named container (labelled `oma=sandbox` for orphan GC), executes allowed commands with `docker exec`, and removes the container on `destroy()` when cleanup policy permits it. `cleanup: "on-success"` is conservative: it preserves the container unless destroy is called with an explicit successful outcome. Host environment variables are not forwarded unless explicitly configured.

Hardening defaults:

- `mountMode` defaults to `"rw"` for compatibility. **The risk is real**: the container runs as root, so a rw mount lets contained code rewrite the mounted host directory (and create root-owned files in it). Prefer `"ro"` for untrusted workloads.
- `--memory` defaults to `2g` and `--pids-limit` to `512`; override with the `memory`/`pidsLimit` policy fields.
- `network: "disabled"` runs the container with `--network none`.

Policy limits are caps, not defaults: `timeoutMs`/`outputLimitBytes` in the policy bound what individual exec requests may ask for.

When an exec request times out, the adapter kills the container (killing the docker CLI client alone would leave the command running inside) and the sandbox becomes unusable; provision a fresh one.

Tests are gated by `OMA_DOCKER_IMAGE` and a running Docker daemon to avoid implicit image pulls in the default suite. Run locally with `OMA_DOCKER_IMAGE=alpine:3.20 bun test packages/adapters/sandbox-docker`.
