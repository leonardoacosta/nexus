# Add Fleet Exceptions Feed

## Why

Leo needs to physically see beads/backlog state across all ~/dev projects — but
the 2026-07-07 portfolio audit showed the board state is heavily noise (151
stale in_progress claims fleet-wide, write-only trackers, phantom epic claims),
and both dashboard recons (docs/recon/beadboard.md,
beads-task-issue-tracker.md) are browsable mirrors of exactly that noise. The
locked doctrine: render shape and exceptions, never browsable items; surfaces
are silent when clean (session-primer/ratchet principle). What to steal from
the recon is the data layer, not the lenses.

## What Changes

- Agent-side fleet beads reader adapted from beadboard (MIT, attribution in
  source headers): Dolt two-query whole-graph read primary
  (upstream `src/lib/read-issues-dolt.ts` — discovery via `.beads/metadata.json`
  + `dolt-server.port`), `issues.jsonl` parse fallback, never throws.
- Exception computation over every `~/dev/*/.beads` store, classes: P0/P1 open,
  in_progress claims stale > 7 days, ready-head older than 30 days, plus a
  cheap openspec funnel signal (unarchived `openspec/changes` dir count per
  repo — the roadmap-awareness gap both upstream tools lack).
- `GET /exceptions` on nexus-agent: stale-while-revalidate cache (TTL 5 min,
  detached background refresh — the roadmap-pulse shape), fail-soft empty-200.
- Surfaces, silent when clean: a menubar exceptions section (renders ONLY when
  exceptions exist; absent otherwise) and one exceptions row on the web /radar
  page (hidden when clean). Per-repo lines show class + count + worst offender
  id, capped — never a scrollable item list.

## Non-Goals

- No kanban/board/graph/social lenses (recon verdict: skip).
- No bead mutation from any surface — read-only feed.
- No per-item drill-in UI; offender ids are text for use in a terminal.

## Impact

- Affected specs: new capability `exceptions-feed`.
- Affected code: `apps/agent/src/` (reader lib + exceptions route),
  `apps/swift/nexus-mac` (menubar section), `apps/web/src/app/radar`
  (one row), NexusShared model for the payload.

## Testing

- Reader: fixture `.beads` dirs (dolt-less → JSONL path), malformed JSONL
  tolerated, missing dir skipped silently.
- Exceptions: unit tests per class threshold; clean fixture yields empty set.
- Route: vitest — SWR cache behavior, fail-soft.
- Surfaces: clean feed renders nothing (menubar section absent, web row
  hidden) — asserted, since silence is the load-bearing feature.
