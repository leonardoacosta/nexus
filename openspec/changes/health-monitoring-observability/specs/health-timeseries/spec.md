# health-timeseries

## ADDED Requirements

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
