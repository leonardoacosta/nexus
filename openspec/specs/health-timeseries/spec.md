# health-timeseries Specification

## Purpose
TBD - created by archiving change add-sqlite-analytics. Update Purpose after archive.
## Requirements
### Requirement: The system MUST sample health metrics to SQLite every 30 seconds
The HealthCollector MUST write CPU, memory, disk, load, and uptime to the `health_samples` table at 30-second intervals, and the agent MUST expose a `GET /analytics/health` endpoint for querying historical data.

#### Scenario: Regular health sampling
Given the HealthCollector refreshes system metrics every 5 seconds
When 30 seconds have elapsed since the last sample write
Then a new row is inserted into health_samples with current CPU, memory, disk, load, and uptime

#### Scenario: Query health history
Given health samples have been collected for the past 6 hours
When GET /analytics/health?hours=6 is called
Then the response contains sampled data points for the requested window

### Requirement: Timestamp index migration for healthSnapshots
The `healthSnapshots` table MUST have a btree index on the `timestamp` column to support time-range queries at scale. The Drizzle schema already declares `index("health_snapshots_timestamp_idx").on(table.timestamp)` — a migration file MUST be generated via `pnpm drizzle-kit generate` so the index is applied to existing deployment databases.

#### Scenario: Query at 100k+ rows
- **GIVEN** a healthSnapshots table with >100k rows
- **WHEN** a caller issues `SELECT ... WHERE timestamp BETWEEN x AND y`
- **THEN** Postgres EXPLAIN shows an index scan, not a sequential scan

### Requirement: Structured warn logging for Docker collection failures in HealthCollector
The `collectDocker()` catch block in HealthCollector MUST log at WARN level (not DEBUG) so Docker daemon failures are visible at default log levels. The log entry MUST include enough context to identify the backoff duration so an operator can understand when the next retry will occur.

#### Scenario: Docker daemon unavailable
- **GIVEN** Docker is not running on the host
- **WHEN** HealthCollector runs its next collection cycle
- **THEN** a log entry at WARN level is emitted naming the failure and the next retry time, not a silent debug entry

### Requirement: Real PG integration coverage for health persistence
The 9 stubbed integration tests for health persistence MUST be replaced with real assertions that run against a live POSTGRES_URL, covering insert round-trip, null metric fields, time-series ordering, scheduler write-on-tick, time-range filter, default window, input validation (invalid and negative hours), and empty-result behavior. Tests MUST retain their `skipIf(!POSTGRES_URL)` guard so they are skipped in CI environments without PG.

#### Scenario: POSTGRES_URL is set in CI
- **GIVEN** a CI environment with POSTGRES_URL set
- **WHEN** `pnpm --filter @nexus/agent test` runs
- **THEN** the 9 previously-stubbed tests execute real inserts and queries against PG and pass

### Requirement: Indexed Timestamp For Health Time-Series

The `health_snapshots` table MUST have a committed timestamp index (schema + generated migration) so time-series queries that filter or order by `timestamp` are fast.

#### Scenario: Time-series query uses the timestamp index

- **WHEN** a query selects health snapshots ordered or filtered by `timestamp`
- **THEN** the query planner uses the `health_snapshots_timestamp_idx` index rather than a full scan, and the index is present in a committed migration under `packages/db/drizzle`

### Requirement: Health Collection Errors Are Logged Not Swallowed

`HealthCollector` MUST emit structured logs (via the agent's `createLogger`/pino logger) when collection fails, so errors surface instead of being silently swallowed.

#### Scenario: Collector logs on a collection error

- **WHEN** a metric or docker collection step in `apps/agent/src/health-collector.ts` throws
- **THEN** the error is recorded via the structured logger with enough context to triage, and collection continues without crashing the agent

### Requirement: Scheduler Captures All Disks On Multi-Disk Systems

`HealthScheduler` MUST capture every disk's data on multi-disk systems instead of dropping data by reading only a single disk entry.

#### Scenario: Multi-disk system reports all disks

- **WHEN** `apps/agent/src/health-scheduler.ts` processes metrics on a host with more than one disk
- **THEN** all disks are captured in the recorded snapshot, not just `disk[0]`, so no mount is silently lost

