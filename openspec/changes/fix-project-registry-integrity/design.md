## Context

The `add-project-registry` change introduced the canonical project registry (projects +
project_locations tables). Post-implementation audit identified 10 correctness gaps and 3
GCF items. This design covers the non-obvious decisions; straightforward fixes are described
only in tasks.md.

## Goals / Non-Goals

- Goals:
  - Eliminate duplicate upserts from symlinked directories
  - Close the race between insert and select in `upsertProjectLocations`
  - Make the upsert synchronous so the cache never serves stale-before-written data
  - Align project identity to git remote URL to prevent cross-machine name collisions
  - Prevent unbounded DB growth from stale entries
  - Remove the Rust discovery endpoint that silently diverges from the DB

- Non-Goals:
  - Full migration of the Rust agent to Bun (out of scope; only the discovery endpoint is removed)
  - Real-time WebSocket sync of project changes
  - Cross-agent transaction coordination

## Decisions

### Decision: dedup set scope

The `seenCanonicalPaths` set is reset once per cache-miss compute cycle (at the top of the
scan block), not persisted at module level across cycles. Persisting it across cycles would
prevent re-discovering a path if a symlink is added after the first scan.

Alternatives considered: Using the DB as the dedup store — rejected because it adds a round-
trip per entry during the scan phase.

### Decision: retry select rather than transaction

After `INSERT … ON CONFLICT DO NOTHING` the select is retried once (immediate, no sleep).
A full transaction would require serializable isolation to be safe and is disproportionate
for a low-contention write path. One retry handles the common case (concurrent agent beats us
to insert; our select sees the row on retry).

### Decision: await upsert — block response

Awaiting the upsert adds latency to `/projects/discovered`. However, the 5 s cache TTL means
the endpoint is called at most once per 5 s per process; blocking for a DB write (typically
<50 ms) is acceptable. The alternative — extending cache TTL beyond upsert duration — would
just defer the problem.

### Decision: composite unique (name, git_remote_url) with NULL semantics

PostgreSQL treats NULLs as distinct in unique indexes, so `(name=nx, git_remote_url=NULL)` and
`(name=nx, git_remote_url=NULL)` are NOT treated as duplicates. This means two local-only
projects with the same name can coexist, which is the correct behavior (they may be different
repos). Projects with a git remote use the remote URL as the tie-breaker.

Migration note: the existing plain `UNIQUE(name)` constraint is dropped. Any rows with
duplicate names that differ only in remote URL must be resolved before migration.

### Decision: remove Rust /projects/discovered (BREAKING)

The Rust endpoint does not write to the DB. Maintaining two discovery code paths (Rust + Bun)
that produce different outputs is a maintenance hazard. Since the Bun agent is the canonical
write path, the Rust endpoint is removed. Any client currently polling the Rust agent's
discovery endpoint must switch to the Bun agent.

### Decision: 1-hour active window alignment

The 5-minute active window was intentionally tight for the session registry but does not match
the 24-hour query window for the project discovery context. 1 hour matches the `stale project
eviction` threshold in `project-dir-scan/spec.md` and is a natural "within the last working
block" heuristic.

### Decision: stale cleanup — archive not delete

Projects missing for >30 days have their `project_locations` rows deleted and the parent
`projects` row is set to `status='archived'` (not deleted). This preserves the project name
for history (session references remain valid) while hiding it from the active UI.

## Risks / Trade-offs

- Breaking Rust endpoint: Any internal caller targeting the Rust agent's `/projects/discovered`
  must be updated. Risk: low — the only known consumer is the TUI, and it was already intended
  to be migrated to the Bun path.

- Composite unique constraint migration: requires a one-time dedup pass on existing data if
  any duplicate names exist. Risk: low — the project list is small and under active development.

- Await upsert adds latency: typically <50 ms but could spike under DB load. Mitigation: the
  5 s cache means the hot path is served from cache; only the cold compute path is affected.

## Migration Plan

1. Run `pnpm db:generate` after schema change; review SQL; apply via `pnpm db:migrate`.
2. Before migration: `SELECT name, COUNT(*) FROM projects GROUP BY name HAVING COUNT(*) > 1`
   — if any rows returned, resolve duplicates manually.
3. Deploy Bun agent (new schema + await upsert) before removing Rust endpoint.
4. Remove Rust `/projects/discovered` route; rebuild: `cargo build -p nexus-agent`.
5. Stale cleanup job runs at next agent boot — no manual intervention needed.

## Open Questions

- Should `git_remote_url` also be stored on the `projects` table (not just `project_locations`)
  for faster cross-agent dedup at query time? Decision deferred; start with `project_locations`
  only and add to `projects` if query performance requires it.
