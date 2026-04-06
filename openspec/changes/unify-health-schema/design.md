# Design: Unify Health Schema

## Context

Nexus runs a hybrid Rust + TypeScript stack. The Rust `nexus-agent` daemon collects system
metrics via `sysinfo` and historically wrote samples directly to a local SQLite database. The
TypeScript overlay (`apps/agent`) independently introduced a PostgreSQL-backed
`health_snapshots` table with a different column set. Both paths are active, creating split
ownership with no clear source of truth for health time-series data.

Audit findings (2026-04-06, P1): `health_samples` (SQLite, 10 cols) vs `health_snapshots`
(PostgreSQL, 6 cols) are completely incompatible. Neither can serve as the authoritative history
store without consolidation.

Stakeholders: agent daemon, TS overlay, TUI client, Next.js health dashboard.

## Goals / Non-Goals

Goals:
- Single storage authority: PostgreSQL `health_snapshots` via TS health-scheduler
- Rust health.rs becomes a pure in-process collector (no direct DB writes)
- All mounted disks reported per snapshot (not just `disk[0]`)
- Resilient writes: exponential backoff with jitter for both Rust POST and TS DB insert
- Stale data visibility: `collectedAt` timestamp surfaced in HealthPoller UI

Non-Goals:
- Migrating historical SQLite data into PostgreSQL
- Changing the 30-second snapshot cadence
- Modifying the PostgreSQL `health_snapshots` column set (rawJson already captures full data)
- Changing the TUI client's polling mechanism

## Decisions

### Decision 1: PostgreSQL over SQLite as the single health store

PostgreSQL is already the project's primary datastore for all other time-series data
(specs, git events, credentials). Converging health onto the same store eliminates a
separate SQLite file dependency on every machine and enables cross-machine queries from
a single connection pool.

Alternatives considered:
- Keep SQLite for health only: rejected — perpetuates the dual-schema problem and prevents
  centralized queries.
- Write to both stores temporarily (deprecation period): rejected per CORE.md breaking changes
  policy — clean replacement is preferred over backward compatibility layers.

### Decision 2: Rust health.rs POSTs to TS agent instead of writing DB directly

The TS agent already owns the HTTP API layer and the PostgreSQL connection pool. Rather than
giving the Rust daemon a second database connection path, Rust posts a JSON snapshot to
`POST /health/ingest` on the TS agent (loopback, port 7400). The TS handler calls
`insertHealthSnapshot`, preserving all existing TS persistence logic.

This means the Rust daemon requires the TS agent to be running — an acceptable constraint
given both processes are managed together via systemd on each machine.

Alternatives considered:
- Give Rust direct PostgreSQL access: rejected — would require a second connection pool,
  duplicated schema knowledge, and continued Rust DB coupling.
- Remove Rust health collection entirely: rejected — Rust uses `sysinfo` for some metrics
  (load average precision) not easily replicated in TS without native bindings.

### Decision 3: Exponential backoff with jitter — base 1 s, max 60 s, 3 attempts

Formula: `delay = min(base * 2^attempt + jitter, max)` where jitter is uniform random in
`[0, base]`. Three attempts covers transient DB hiccups without stalling the 30-second
collection loop. After three failures the sample is dropped and an ERROR log is emitted.

Both Rust and TS use the same parameters for consistency. The Rust path applies backoff
to the HTTP POST; the TS path applies it to the DB insert.

Alternatives considered:
- Fixed delay (current): rejected — cannot adapt to prolonged outages, may cause thundering
  herd on recovery.
- Unlimited retries: rejected — would block the next collection cycle indefinitely.

### Decision 4: Disk aggregation — report all mounts, primary percent = weighted average

`health-scheduler.ts` currently takes `disk[0]?.percent`, discarding all other mounts. The
fix stores the full disk array in `rawJson` (already happening) and computes
`diskPercent` as a weighted average across all mounts by used bytes. This gives a meaningful
single-number summary while preserving per-mount detail in `rawJson`.

### Decision 5: `collectedAt` field in HealthMetrics, stale threshold 30 s

The field records when the TS collector last successfully ran `collect()`. HealthPoller
compares `collectedAt` against `Date.now()` on each poll cycle and shows a warning badge
when the delta exceeds 30 seconds. The threshold matches the DB snapshot cadence, so a
full missed cycle is the trigger.

## Migration Plan

1. Add `POST /health/ingest` endpoint to the TS agent.
2. Update Rust `health.rs` to POST to that endpoint instead of writing SQLite.
3. Remove the SQLite `health_samples` insert path from Rust.
4. Run a SQLite migration dropping the `health_samples` table (or leave orphaned — no reads
   depend on it after step 2).
5. Fix disk aggregation in `health-scheduler.ts`.
6. Replace fixed retry delays with exponential backoff in both Rust and TS.
7. Add `collectedAt` to `HealthMetrics` type in `@nexus/core`.
8. Populate `collectedAt` in `health-collector.ts`.
9. Display stale indicator in `HealthPoller.tsx`.
10. Add Pino logging context to `health-collector.ts` and `health-scheduler.ts`.

Rollback: revert Rust health.rs to SQLite path; TS path is additive and can remain.

## Risks / Trade-offs

- Rust→TS HTTP POST adds loopback latency on every 30-second write cycle. At one call per
  30 s this is negligible. → Mitigation: no action needed; monitor if cadence increases.
- If the TS agent is down, the Rust POST fails and the sample is dropped (after backoff).
  Historical data will have gaps during TS outages. → Mitigation: ERROR log on final retry
  so operators can detect gaps; acceptable given PostgreSQL is the authoritative store.
- Weighted average disk percent may differ from `disk[0]?.percent` for existing dashboards
  that relied on the first-mount value. → Mitigation: raw per-mount data in `rawJson`
  remains accessible; this is a P2 fix not a regression.

## Open Questions

- Should the SQLite `health_samples` table be actively dropped via migration, or simply
  stop being written to and cleaned up later? (Current recommendation: drop via migration
  to free disk space on long-running agents.)
- Does the TUI client need updating to consume `collectedAt` for its own stale indicator,
  or is this Next.js dashboard only? (Scoped to Next.js for this change; TUI left as
  follow-up.)
