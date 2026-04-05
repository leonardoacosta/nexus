# Proposal

## Change ID
fix-health-monitoring-types

## Summary
Align the Rust `MachineHealth` struct with the TypeScript `HealthMetrics` interface, add error visibility for Docker unavailability and DB write failures, make retention configurable via env var, and add a timestamp index to the `health_snapshots` table.

## Context
The Nexus project is a v2 TypeScript-first rewrite. `packages/core/src/types/health.ts` is the canonical health schema — it carries a rich, structured breakdown of CPU (per-core), RAM (bytes), multi-disk mounts, and network interfaces. The legacy Rust `MachineHealth` struct (`crates/nexus-core/src/health.rs`) uses coarse `f32` GB fields and a flat `load_avg` array, creating a semantic gap between what the Rust agent exposes and what the TypeScript agent and TUI expect.

In parallel, several silent failure modes have been identified:
- Docker unavailability is silently swallowed in both the Rust and TypeScript collectors.
- DB write failures in `health-scheduler.ts` have no retry or backoff.
- `HealthCollector.tick()` catches all errors with an empty block, dropping telemetry.
- Retention is hardcoded to 30 days with no operator escape hatch.
- `health_snapshots.timestamp` has no index, causing full-table scans on time-range queries.
- Five integration tests covering DB persistence are skipped.

## Motivation
- **Type mismatch (P1)**: The Rust agent's `/health` endpoint serializes `MachineHealth` (GB floats), while the TUI and TypeScript agent expect `HealthMetrics` (bytes + per-core breakdown). This breaks the Health view when both agents coexist.
- **Silent failures (P2)**: Docker unavailability and DB write failures are operationally invisible. No logs, no metrics.
- **Retention inflexibility (P2)**: Operators cannot tune data retention without a code change.
- **Performance (P2)**: Time-series queries over `health_snapshots` without a timestamp index degrade at scale.
- **Test coverage gap (P2)**: Skipped integration tests mean DB persistence is untested in CI.

## Requirements

### Req-1: Unified health schema
The Rust `MachineHealth` struct MUST be updated to match the TypeScript `HealthMetrics` interface, with TypeScript as the source of truth for the canonical field layout. The Rust struct MUST carry: `hostname`, `uptime_seconds`, `cpu` (overall percent + per-core percent + load average), `ram` (total/used bytes), `disk` (array of mount/total/used/percent), and `docker` (container count + running count or null).

#### Scenario: Rust agent health endpoint returns canonical schema
- **WHEN** a TUI client calls `GET /health` on a Rust-backed agent
- **THEN** the JSON response matches the `HealthMetrics` shape used by the TypeScript agent — same field names, byte-based units, and nested structure

#### Scenario: Backward-incompatible fields removed
- **WHEN** the Rust `MachineHealth` struct is compiled after the change
- **THEN** `memory_used_gb`, `memory_total_gb`, `disk_used_gb`, `disk_total_gb` no longer exist as top-level fields

### Req-2: Health collection error visibility
The system MUST emit a `tracing::warn!` log entry when Docker is unavailable during a collection cycle. The TypeScript `HealthScheduler` MUST log errors (via the pino logger) in all catch blocks in `tick()`. The TypeScript `HealthCollector.tick()` MUST log a warning when collection fails rather than silently discarding the error. DB write failures in `HealthScheduler` MUST be retried once with a 2-second backoff before logging a final error.

#### Scenario: Docker daemon unreachable — Rust
- **WHEN** `detect_docker_containers()` returns `None` due to a Docker command failure
- **THEN** `tracing::warn!` is emitted with the reason before the function returns `None`

#### Scenario: Docker daemon unreachable — TypeScript
- **WHEN** `HealthCollector.collectDocker()` throws
- **THEN** a pino `warn` log is emitted with the error message and `docker: null` is returned

#### Scenario: Health collection tick failure — TypeScript
- **WHEN** `HealthCollector.tick()` catches an error
- **THEN** a pino `warn` log is emitted with the error before keeping stale data

#### Scenario: DB write failure with retry
- **WHEN** `HealthScheduler` fails to insert a health snapshot
- **THEN** it waits 2 seconds and retries once; if the retry also fails, a pino `error` log is emitted

### Req-3: Configurable retention
The health snapshot retention period MUST be configurable via the `HEALTH_RETENTION_DAYS` environment variable, defaulting to `30` when not set. The `events` retention MUST remain at its existing hardcoded value unless separately configured.

#### Scenario: Custom retention via env var
- **WHEN** `HEALTH_RETENTION_DAYS=7` is set in the environment
- **THEN** `runRetentionCleanup` deletes health snapshots older than 7 days

#### Scenario: Default retention unchanged
- **WHEN** `HEALTH_RETENTION_DAYS` is not set
- **THEN** `runRetentionCleanup` deletes health snapshots older than 30 days (existing behavior)

### Req-4: Timestamp index on healthSnapshots
The `health_snapshots` table MUST have a Drizzle-managed index on the `timestamp` column so that time-range queries (`WHERE timestamp >= ? AND timestamp <= ?`) can use an index scan instead of a full table scan.

#### Scenario: Index exists after migration
- **WHEN** the Drizzle migration is applied
- **THEN** `health_snapshots_timestamp_idx` exists on the `health_snapshots.timestamp` column

#### Scenario: Time-range query uses index
- **WHEN** `GET /analytics/health?hours=6` is called with 100 000+ rows in `health_snapshots`
- **THEN** the query completes without a full-table scan (query plan shows index usage)

### Req-5: TypeScript health collection logging
The TypeScript `HealthCollector` and `HealthScheduler` MUST import and use the pino logger from `@nexus/core` in all error and warning paths. No error or warning condition in these modules MAY be silently swallowed without a corresponding log entry.

#### Scenario: HealthCollector uses logger
- **WHEN** `HealthCollector` is instantiated
- **THEN** it imports `logger` from `@nexus/core` and calls `logger.warn` or `logger.error` in every catch block

#### Scenario: HealthScheduler Docker catch path logged
- **WHEN** `HealthScheduler.tick()` catches an error from `HealthCollector.collect()`
- **THEN** `logger.error` is called with the error details before the method returns

## Scope
**In scope:**
- `crates/nexus-core/src/health.rs` — Rust `MachineHealth` struct update
- `crates/nexus-agent/src/health.rs` — `build_health_from_system`, Docker warn logging
- `apps/agent/src/health-collector.ts` — pino logger in all catch blocks
- `apps/agent/src/health-scheduler.ts` — pino logger + DB write retry
- `apps/agent/src/db/retention.ts` — `HEALTH_RETENTION_DAYS` env var
- `packages/db/src/schema/healthSnapshots.ts` — timestamp index
- Integration tests currently skipped in `health-history.test.ts`

**Out of scope:**
- OTel span granularity (nx-v6pq — P3 backlog)
- `System::refresh_all()` performance optimization (nx-9ju0 — P3 backlog)
- HealthPoller stale data UI indicator (nx-u047 — P3 backlog)
- Multi-disk aggregation in HealthScheduler (nx-k7xa — P3 backlog)

## Impact
- **Affected specs**: `health-timeseries`, `health-monitoring` (new delta)
- **Affected code**: `crates/nexus-core/src/health.rs`, `crates/nexus-agent/src/health.rs`, `apps/agent/src/health-collector.ts`, `apps/agent/src/health-scheduler.ts`, `apps/agent/src/db/retention.ts`, `packages/db/src/schema/healthSnapshots.ts`
- **Breaking change**: Rust `MachineHealth` field layout changes — any consumers of the Rust `/health` endpoint that parse the old GB-float fields will need updating.

## Risks
- **Rust schema change is breaking**: The Rust agent's `/health` endpoint changes its JSON shape. The TUI must be updated in the same pass to use the new field names or the Health view will break. Mitigation: update the TUI's Rust deserialization alongside the struct change.
- **DB migration required**: Adding the timestamp index requires a Drizzle migration. If the migration is not run, the index will not exist. Mitigation: include the migration file in the same PR and verify via `drizzle-kit generate`.
- **Integration test re-enablement**: Un-skipping tests may reveal pre-existing DB persistence bugs beyond the scope of this change. Mitigation: fix only failures directly caused by the schema or type mismatches addressed here; file separate issues for others.
