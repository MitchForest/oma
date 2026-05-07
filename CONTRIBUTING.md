# Contributing

OMA uses Bun as the only blessed package manager and script runner.
Linting and formatting use the Oxc toolchain: Oxlint and Oxfmt.

## Local Setup

```sh
bun install
bun run verify
```

## Standards

- Keep the core runtime small and dependency-light.
- Prefer explicit TypeScript types over hidden behavior.
- Do not add providers, sandboxes, servers, or UI until the phase plan calls for them.
- Add tests with every runtime behavior change.
- Keep generated or example-only code out of core packages.

## Before Handoff

Run:

```sh
bun run verify
```
