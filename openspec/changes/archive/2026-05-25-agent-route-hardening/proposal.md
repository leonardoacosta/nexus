# agent-route-hardening

## Why

Two agent backend correctness bugs cause silent failures. `readProcessCwd` returns undefined for legacy session rows that have an empty `cwd`, even though a shell-level `/proc/<pid>/cwd` readlink resolves successfully — so those sessions lose their working directory. Separately, the projects-discovered route returns HTTP 200 when `readdirSync` throws, masking filesystem failures from clients that then treat a broken scan as an empty-but-healthy result.

## What Changes

- Fix `readProcessCwd` to fall back to a `/proc/<pid>/cwd` readlink for legacy empty-cwd rows so a real working directory is recovered.
- Fix the projects-discovered handler to return HTTP 500 (not 200) when `readdirSync` throws, so clients can distinguish a scan failure from an empty result.

## Context

- touches: `apps/agent/src/services/process-watcher.ts`, `apps/agent/src/routes/projects-discovered.ts`

## Non-Goals

- Reworking the broader process-watcher tmux/cwd resolution strategy.
- Changing the projects-discovered response shape for the success path.
- Backfilling or migrating historical session rows.
