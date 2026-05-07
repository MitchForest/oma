# Agent Instructions

This repository is OMA, an open outcome runtime for long-running agents.

Follow `.docs/plan.md` when choosing scope. Do not skip ahead into later phases unless the user asks.

## Tooling

- Use Bun as the only package manager and script runner.
- Use Oxlint and Oxfmt through the root package scripts.
- Run `bun install` after dependency changes.
- Run `bun run verify` before handoff when feasible.

## Code Style

- Keep core runtime code small, typed, and dependency-light.
- Prefer stable contracts over provider-specific shortcuts.
- Keep examples and templates separate from product packages.
- Do not introduce server, UI, sandbox, or provider dependencies into `@oma/runtime` without a phase-plan reason.

## Current Package Naming

The core runtime package is `@oma/runtime`.
