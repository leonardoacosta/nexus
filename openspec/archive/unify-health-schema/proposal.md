# Change: Unify health storage schema — eliminate Rust SQLite writer

## Why

The platform audit (2026-04-06) found two completely incompatible health schemas in production:
the Rust agent writes CPU/memory/disk/load/uptime across 10 columns to SQLite `health_samples`,
while the TypeScript agent writes a 6-column subset to PostgreSQL `health_snapshots`. Neither
schema is queryable from the other, and live-data gaps (disk aggregation, backoff, stale
indicators) exist in both paths. This change designates PostgreSQL + TS as the single health
storage authority and reduces the Rust layer to a pure collector.

## What Changes

- **BREAKING**: `health_samples` SQLite table is eliminated. The Rust HealthCollector no longer
  writes to SQLite; all health persistence goes through the TS `health-scheduler → health_snapshots`
  PostgreSQL path.
- Rust `health.rs` becomes collector-only: it gathers sysinfo data and POSTs the snapshot to the
  TS agent's `/health/ingest` endpoint instead of writing to SQLite directly.
- **BREAKING**: `GET /analytics/health` (Rust SQLite-backed) is removed. Health time-series
  queries are served exclusively from `GET /analytics/health` on the TS agent (PostgreSQL-backed).
- Disk aggregation fixed: `health-scheduler.ts` reports all mounted disks, not just `disk[0]`.
- Exponential backoff with jitter added to both Rust and TS health writers (base 1 s, max 60 s,
  3 attempts) — replaces the fixed 1 s (Rust) and 2 s (TS) delays.
- `collectedAt` timestamp field added to `HealthMetrics`; `HealthPoller.tsx` displays a stale
  data warning when the last collection is >30 s old.
- Pino structured logging context added to `health-collector.ts` and `health-scheduler.ts`.

## Impact

- Affected specs: `health-timeseries`
- Affected code:
  - `crates/nexus-agent/src/health.rs` — remove SQLite insert path, add HTTP POST to TS agent
  - `apps/agent/src/health-scheduler.ts` — disk aggregation, exponential backoff, Pino context
  - `apps/agent/src/health-collector.ts` — add `collectedAt`, Pino context
  - `apps/agent/src/db/health.ts` — no schema changes required (rawJson covers full disk array)
  - `apps/nextjs/src/components/HealthPoller.tsx` — stale indicator using `collectedAt`
  - SQLite schema — drop `health_samples` table (migration required)
