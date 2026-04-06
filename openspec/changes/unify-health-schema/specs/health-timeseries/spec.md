## MODIFIED Requirements

### Requirement: The system MUST sample health metrics to PostgreSQL every 30 seconds
The TS HealthScheduler MUST write CPU percent, RAM percent, a weighted-average disk percent,
Docker container count, and a full `rawJson` blob to the `health_snapshots` PostgreSQL table
at 30-second intervals. The Rust HealthCollector MUST POST its sysinfo snapshot to the TS
agent's `POST /health/ingest` endpoint; the Rust agent MUST NOT write directly to any database.
The agent MUST expose a `GET /analytics/health` endpoint (TS, PostgreSQL-backed) for querying
historical data.

#### Scenario: Regular health sampling via TS scheduler
- **WHEN** 30 seconds have elapsed since the last snapshot write
- **THEN** a new row is inserted into `health_snapshots` with `cpuPercent`, `ramPercent`,
  `diskPercent` (weighted average across all mounts), `dockerContainers`, and `rawJson`

#### Scenario: Rust collector delegates persistence to TS agent
- **WHEN** the Rust HealthCollector completes a metrics cycle
- **THEN** it POSTs the serialised `HealthMetrics` JSON to `http://127.0.0.1:7400/health/ingest`
- **AND** the TS ingest handler calls `insertHealthSnapshot` to persist the data
- **AND** no SQLite write occurs

#### Scenario: Query health history
- **WHEN** `GET /analytics/health?hours=6` is called on the TS agent
- **THEN** the response contains sampled data points from `health_snapshots` for the requested window

## ADDED Requirements

### Requirement: The system MUST aggregate all mounted disks when computing diskPercent
The TS HealthScheduler MUST compute `diskPercent` as a weighted average across all entries in
`metrics.disk`, weighted by each mount's `total_bytes`, rather than using only the first
mount's percent.

#### Scenario: Multi-disk host reports weighted average
- **WHEN** a host has mounts at `/` (500 GB, 60% used) and `/data` (2 TB, 40% used)
- **THEN** `diskPercent` reflects the combined weighted average, not 60%

#### Scenario: Single-disk host is unaffected
- **WHEN** a host has exactly one mount
- **THEN** `diskPercent` equals that mount's `percent` value

### Requirement: The system MUST retry health writes with exponential backoff
Both the Rust HTTP POST to `/health/ingest` and the TS `insertHealthSnapshot` call MUST
retry on failure using exponential backoff with jitter: base delay 1 second, maximum delay
60 seconds, maximum 3 attempts total. After all attempts are exhausted the sample MUST be
dropped and an ERROR-level log MUST be emitted.

#### Scenario: Transient DB failure recovers on second attempt
- **WHEN** the first `insertHealthSnapshot` call throws a connection error
- **THEN** the scheduler waits `base * 2^1 + jitter` seconds and retries
- **AND** if the second attempt succeeds, no error is logged

#### Scenario: Persistent failure after 3 attempts
- **WHEN** all three insert attempts fail
- **THEN** the sample is dropped, an ERROR log is emitted, and the scheduler continues normally on the next tick

#### Scenario: Rust POST retries with backoff on network error
- **WHEN** the Rust agent's HTTP POST to `/health/ingest` fails with a connection refused error
- **THEN** it retries up to 3 times with exponential backoff before dropping the sample

### Requirement: The system MUST surface stale health data in the HealthPoller UI
`HealthMetrics` MUST include a `collectedAt` ISO-8601 timestamp field set by the TS
HealthCollector at the moment each collection cycle completes. The `HealthPoller` component
MUST display a visible stale warning when `Date.now() - new Date(collectedAt).getTime()`
exceeds 30 000 ms (30 seconds).

#### Scenario: Fresh data shows no stale indicator
- **WHEN** the most recent `collectedAt` is less than 30 seconds ago
- **THEN** no stale warning is displayed on the MachineCard

#### Scenario: Stale data triggers warning badge
- **WHEN** the most recent `collectedAt` is more than 30 seconds ago
- **THEN** a stale data warning badge is displayed on the MachineCard with the last-updated time

### Requirement: Health collector and scheduler MUST emit structured Pino log context
`health-collector.ts` and `health-scheduler.ts` MUST include structured log fields
(`hostname`, `intervalMs` on scheduler start; `hostname`, `cpuPercent`, `diskPercent` on
each successful tick) using the project's `logger` (Pino) instance.

#### Scenario: Scheduler start emits structured log
- **WHEN** `HealthScheduler.start()` is called
- **THEN** a `logger.info` call emits `{ intervalMs, hostname }` at INFO level

#### Scenario: Tick success emits metric context
- **WHEN** a scheduler tick completes successfully
- **THEN** a `logger.debug` call emits `{ hostname, cpuPercent, diskPercent }` fields

## REMOVED Requirements

### Requirement: The system MUST sample health metrics to SQLite every 30 seconds
**Reason**: SQLite `health_samples` is superseded by PostgreSQL `health_snapshots`. The Rust
daemon's direct SQLite writer is eliminated; all persistence goes through the TS
health-scheduler. See `design.md` § Decision 1 and Decision 2.
**Migration**: Drop the `health_samples` SQLite table via migration. No data migration to
PostgreSQL — historical SQLite samples are discarded. The TS PostgreSQL path continues
accumulating new samples from the cutover date forward.
