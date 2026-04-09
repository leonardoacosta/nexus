## MODIFIED Requirements

### Requirement: The system MUST sample health metrics to PostgreSQL every 30 seconds
The TS HealthScheduler MUST persist system metrics to the `health_snapshots` PostgreSQL table
at 30-second intervals by reading the cached snapshot from `HealthCollector.getLatest()`. The
scheduler MUST NOT call `collector.collect()` directly; doing so would re-run sysinfo queries
and duplicate the work already performed by the collector's own background timer. If
`getLatest()` returns `null` (collector not yet warmed up), the tick MUST be skipped and a
debug-level log emitted. The Rust HealthCollector MUST POST its sysinfo snapshot to the TS
agent's `POST /health/ingest` endpoint; the Rust agent MUST NOT write directly to any
database. The agent MUST expose a `GET /analytics/health` endpoint (TS, PostgreSQL-backed)
for querying historical data.

#### Scenario: Scheduler reads from cache, not live sysinfo
- **WHEN** the scheduler tick fires
- **THEN** `collector.getLatest()` is called to obtain the current snapshot
- **AND** `collector.collect()` is NOT called during the tick

#### Scenario: Collector not yet warmed up
- **WHEN** the scheduler fires before the collector has completed its first cycle
- **THEN** the tick is skipped with a debug log and no database write occurs

#### Scenario: Regular health sampling via TS scheduler
- **WHEN** 30 seconds have elapsed since the last snapshot write and `getLatest()` returns a
  non-null value
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

### Requirement: Docker detection MUST use exponential backoff after failures
`HealthCollector.collectDocker()` MUST track backoff state across calls. After a failure the
next Docker detection attempt MUST be delayed: starting at 30 s, doubling on each consecutive
failure, capped at 600 s (10 minutes). On a successful detection the backoff MUST reset to the
initial 30 s interval. A debug log MUST be emitted when a check is skipped due to backoff,
including the `nextCheckMs` value so the suppression window is observable.

#### Scenario: First Docker failure starts backoff
- **WHEN** `collectDocker()` fails for the first time
- **THEN** the next attempt is suppressed for 30 s
- **AND** a debug log is emitted with `{ nextCheckMs: 30000 }`

#### Scenario: Consecutive failures double the backoff
- **WHEN** Docker detection has failed N consecutive times
- **THEN** the backoff window after failure N is `min(30_000 * 2^(N-1), 600_000)` ms

#### Scenario: Backoff caps at 10 minutes
- **WHEN** Docker detection has failed enough times to exceed the cap
- **THEN** subsequent failures are each suppressed for exactly 600 s
- **AND** no attempt is made more frequently than once per cap window

#### Scenario: Successful detection resets backoff
- **WHEN** Docker detection succeeds after a period of backoff
- **THEN** `dockerBackoffMs` resets to 30 000 ms and the next check runs on the normal schedule

#### Scenario: Skipped check during backoff window
- **WHEN** `collectDocker()` is called while `Date.now() < dockerBackoffUntil`
- **THEN** `null` is returned immediately without spawning a subprocess

### Requirement: HealthPoller MUST warn on fetch failure instead of failing silently
When `fetchHealth()` throws, `HealthPoller` MUST emit a `console.warn` with the error before
retaining the existing stale data. Silent failure makes stale-data periods invisible to
developers inspecting the browser console.

#### Scenario: fetchHealth failure logs a warning
- **WHEN** `fetchHealth()` rejects during a poll interval
- **THEN** `console.warn` is called with a message identifying the component and the error
- **AND** the component continues to display the last successfully fetched data
