## MODIFIED Requirements

### Requirement: Unified Health Schema
The Rust `MachineHealth` struct and TypeScript `HealthMetrics` type MUST share a canonical schema
with per-component CPU/RAM/disk fields. TypeScript is the source of truth; Rust types MUST align.

#### Scenario: Rust agent health payload matches TypeScript type
- **WHEN** the Rust agent serializes a health sample
- **THEN** the JSON shape is accepted by the TypeScript `HealthMetrics` schema without coercion

#### Scenario: f32 GB values replaced with structured breakdown
- **WHEN** health data is collected
- **THEN** CPU is expressed as `{ usage_percent: f64 }`, RAM as `{ used_bytes, total_bytes }`, and disk as `[{ mount, used_bytes, total_bytes }]`

### Requirement: Health Collection Error Visibility
Docker unavailability and DB write failures MUST be logged with `tracing::warn!` (Rust) or `logger.warn()` (TypeScript).

#### Scenario: Docker unavailable emits warning
- **WHEN** `detect_docker_containers` returns `None`
- **THEN** `tracing::warn!("docker unavailable")` is called

#### Scenario: DB write failure retried then logged
- **WHEN** `db.insert_health_sample` fails
- **THEN** up to 3 retries with 100ms backoff; after 3 failures, a Sentry breadcrumb is emitted

### Requirement: Configurable Retention Policy
Health snapshot retention TTL MUST be configurable via `HEALTH_RETENTION_DAYS` environment variable (default 30).

#### Scenario: custom retention applied
- **WHEN** `HEALTH_RETENTION_DAYS=7` is set
- **THEN** health snapshots older than 7 days are deleted by the retention job

#### Scenario: default retention is 30 days
- **WHEN** `HEALTH_RETENTION_DAYS` is not set
- **THEN** health snapshots older than 30 days are deleted

### Requirement: Timestamp Index on healthSnapshots
The `healthSnapshots` schema MUST include an index on the `timestamp` column.

#### Scenario: time-series query uses index
- **WHEN** `queryHealthTimeSeries` filters by timestamp range on a table with >100k rows
- **THEN** the query plan uses the `idx_health_snapshots_timestamp` index

### Requirement: Logging in TypeScript Health Collection
`HealthCollector` and `HealthScheduler` MUST log errors via pino; silent catch blocks are forbidden.

#### Scenario: HealthCollector tick error logged
- **WHEN** `HealthCollector.tick()` catches an error
- **THEN** `logger.warn({ err }, "health collection failed")` is called
