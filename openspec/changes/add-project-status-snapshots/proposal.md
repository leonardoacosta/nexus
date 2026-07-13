# Proposal: Per-Project Status Snapshots (openspec + beads counts, persisted and served)

## Change ID

`add-project-status-snapshots`

## Summary

Persist per-project status counts — unarchived openspec proposals, and beads that are ready or
blocked AND unrelated to any proposal — as change-only time-series rows in Postgres, driven by
filesystem watching of `.beads/issues.jsonl` (new) and the existing spec-watcher (live). Serve
current state + history over the agent's route conventions and emit a `BeadTransition`
lifecycle-bus event so dashboards update live. This revives the committed-but-dead
`spec-timeseries` capability (SQLite-era `spec_snapshots`, implementation lost in the Postgres
migration) rather than minting a parallel capability.

## Context

- depends on: `add-session-context-api`
- touches: `packages/db/src/schema/projectStatusSnapshots.ts`, `packages/db/src/schema/specSnapshots.ts`, `packages/db/src/schema/index.ts`, `apps/agent/src/db/retention.ts`, `packages/core/src/types/project-status.ts`, `packages/core/src/index.ts`, `apps/agent/src/services/beads-watcher.ts`, `apps/agent/src/services/status-snapshots.ts`, `apps/agent/src/services/lifecycle-bus.ts`, `apps/agent/src/services/spec-watcher/index.ts`, `apps/agent/src/routes/project-status.ts`, `apps/agent/src/server-request-handler.ts`, `apps/swift/NexusShared/Models`, `apps/swift/NexusShared/Observers`

The `add-session-context-api` dependency is soft: this change follows its route/contract
conventions (`tryHandle*` delegation, `packages/core` Zod contract file per capability) and both
edit `apps/agent/src/server-request-handler.ts`.

## Motivation

Nexus is the orbiter of static project status + CC session data. Today the pipeline computes but
never records:

- `spec-watcher` (fs.watch on `openspec/changes/` + 60s poll) holds per-project spec state
  in-memory only — counts die on agent restart, no trends.
- `bead-rollup` / `beads-unlinked` compute ready/blocked + proposal-unlinked beads live per
  request via `bd list` — pull-only, nothing evented, nothing persisted.
- `spec-timeseries`'s committed requirement ("insert a timestamped snapshot into
  `spec_snapshots`") has had no implementation since the SQLite -> Postgres migration
  (2026-04-03). Same for `git-event-store` (out of scope here; separate proposal).
- Beads changes have NO change signal at all — no CC hook is bead-shaped (verified against
  cc's settings.json hook inventory), so filesystem watching of the `bd export.auto`-maintained
  `.beads/issues.jsonl` is the only event source that requires no cc-side changes.

## Requirements (canonical text in `specs/` deltas)

1. **Beads filesystem watching** (spec-watcher delta, ADDED): watch each registered project's
   `.beads/` parent directory for `issues.jsonl` rewrites (atomic rename-over safe, per the
   nx-6uzqi pattern in `active-credential-watcher.ts`), 300ms debounce, unconditional 60s poll
   fallback, zero `bd` CLI calls on the hot path (parse JSONL directly).
2. **Per-spec snapshots revived on Postgres** (spec-timeseries delta, MODIFIED): change-only
   inserts into `spec_snapshots` (project, spec_name, completed, total) on spec-watcher ticks.
3. **Per-project status snapshots** (spec-timeseries delta, ADDED): change-only inserts into
   `project_status_snapshots` (project, proposals_unarchived, beads_ready_unlinked,
   beads_blocked_unlinked) whenever either watcher's recount differs from the last row.
4. **Serving** (spec-timeseries delta, ADDED): `GET /projects/:id/status` returns the latest
   snapshot; `?history=<days>` returns the time series. Registered via the same
   `tryHandle*`/`LEGACY_DISPATCH_ROUTES` delegation as `add-session-context-api`.
5. **BeadTransition bus event** (spec-watcher delta, ADDED): emitted on count changes, symmetric
   with `SpecTransition`, exposed on the existing SSE stream.
6. **Derivation parity** (bead-proposal-roadmap delta, ADDED): persisted unlinked ready/blocked
   counts MUST match the live `beads-unlinked` derivation — one derivation source, no fork.
7. **Retention**: both tables pruned at 90 days by `retention.ts` (env-overridable), matching
   `cron_runs`/`bloat_radar`.

## Scope

- In: DB schema + migration (migration-based only — never `db:push`), beads watcher service,
  snapshot writer, bus event, GET routes, core Zod contracts, minimal NexusShared decode of the
  new SSE event, unit/integration tests.
- Out: git status observation (separate `add-git-status-orbit` proposal), Swift dashboard UI
  surfaces beyond event decode, statusline/cc-tmux consumption, any cc-side hook work,
  historical backfill.

## Testing

| Seam | Coverage |
| --- | --- |
| Beads watcher (rename-over rewrite, debounce, poll fallback, missing `.beads/`) | Unit tests, tasks 4.1 |
| Ready/blocked-unlinked derivation parity with `beads-unlinked` route | Unit test comparing both outputs on one fixture, task 4.1 |
| Snapshot writer change-only semantics (no-change skips insert) | Unit tests, task 4.2 |
| GET /projects/:id/status current + history + 404 unknown project | Route tests (PG-gated), task 4.2 |
| Retention prune of both tables | Extend retention tests, task 4.2 |
| BeadTransition emission + SSE exposure | Unit test on lifecycle bus, task 4.1 |
| NexusShared decode of BeadTransition | Codable decode test, task 3.1 |

## Impact

- New tables: `spec_snapshots`, `project_status_snapshots` (+ one generated migration).
- New services: `beads-watcher.ts`, `status-snapshots.ts`; one new event on the lifecycle bus.
- `spec-watcher` gains a snapshot side-effect on its existing tick path (no behavior change to
  transitions).
- Agent deployment note: the watcher's zero-`bd`-call design also avoids the systemd sandbox
  restrictions that break `bd`/`openspec` shell-outs in prod (ReadOnlyPaths/mise PATH).

## Risks

- `issues.jsonl` is a full-dump export with non-deterministic row order — the parser MUST NOT
  assume order and MUST treat parse failures as "keep previous counts" (fail-open, like
  config-watcher).
- Derivation drift between JSONL-based counts and `bd list`-based `beads-unlinked` — guarded by
  the parity requirement + test.
- inotify watch exhaustion with many projects — same ENOSPC degraded-poll-only path the spec
  watcher already documents.
