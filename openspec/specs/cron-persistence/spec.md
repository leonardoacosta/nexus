# cron-persistence Specification

## Purpose
TBD - created by archiving change add-sqlite-consolidation. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist cron job runs to SQLite replacing JSONL
The cron service MUST write job execution results to the `cron_runs` table with timestamp, job name, status, details, and metrics. The JSONL rotation logic MUST be removed.

#### Scenario: Cron job result persisted
Given the daily maintain job completes successfully with 5 items pruned
When the job finishes
Then a row is inserted into cron_runs with job="maintain", status="success", details containing pruned counts

#### Scenario: JSONL file no longer written
Given the cron service runs a job
When the result is recorded
Then no write occurs to cron-log.jsonl (DB is the only destination)

### Requirement: The cron service MUST register a weekly reaper job

The nexus-agent `CronService` MUST register a third internal job, `reaper`,
scheduled weekly for Sunday 03:00 local time, preserving the cadence of the
former OS-timer reaper. The job MUST spawn the vendored bash reaper core as a
child process and forward a dry-run flag when requested.

#### Scenario: Reaper job scheduled at Sunday 03:00

- **WHEN** the cron service starts
- **THEN** a `reaper` job is registered alongside `maintain` and `drift`,
  computed via the existing weekly-schedule helper for day=Sunday,
  hour=03, minute=00, and rescheduled for the next week after each run

#### Scenario: Reaper runs the bash core as a child process

- **WHEN** the `reaper` job fires
- **THEN** the TypeScript wrapper spawns the vendored bash core as a child
  process, captures its stdout/stderr, and never reimplements the destructive
  logic inline

### Requirement: Reaper results MUST be persisted to the cron_runs table

Every `reaper` job execution MUST insert a row into the `cron_runs` table
with the job name, status, a details payload, and metrics. The details
payload MUST include pruned counts and bytes/space freed; metrics MUST
include the run duration.

#### Scenario: Successful reap recorded

- **GIVEN** the reaper completes and frees disk space
- **WHEN** the child process reaches its completion sentinel
- **THEN** a `cron_runs` row is inserted with `job="reaper"`,
  `status="success"`, details containing pruned counts and freed bytes, and
  metrics containing the duration

#### Scenario: Aborted reap recorded as failure

- **GIVEN** the reaper child process exits before its completion sentinel
- **WHEN** the wrapper observes the non-zero exit and the silent-abort
  signature
- **THEN** a `cron_runs` row is inserted with `job="reaper"`,
  `status="failure"`, and details capturing the abort return code and the
  log path for post-mortem

### Requirement: Bloat radar findings MUST be persisted as telemetry

Bloat-radar findings MUST be persisted to SQLite so they are trendable and
dashboard-visible, via a dedicated `bloat_radar` table keyed by run
timestamp. Persistence MUST NOT replace the dedicated spoken TTS warning.

#### Scenario: Radar findings written to the bloat_radar table

- **GIVEN** the radar reports two over-threshold findings in a run
- **WHEN** the reaper job finishes
- **THEN** two rows are inserted into `bloat_radar` (label, path, size bytes,
  threshold bytes, run timestamp), and the dedicated bloat TTS warning is
  still spoken

#### Scenario: Clear run records no findings

- **WHEN** the radar reports "clear"
- **THEN** no rows are inserted into `bloat_radar` for that run and no bloat
  TTS warning is emitted

### Requirement: A missed-run detector MUST fire when the reaper goes stale

The cron service MUST detect a stale reaper. If no `reaper` `cron_runs` row
with `status="success"` exists within the last 8 days, the system MUST emit
a loud TTS plus desktop notification on the next service start and on the
next scheduled reaper tick. This is the sole compensating control for the
accepted no-OS-watchdog risk.

#### Scenario: Stale reaper surfaces loudly

- **GIVEN** the most recent successful `reaper` `cron_runs` row is older than
  8 days, or no such row exists
- **WHEN** the cron service starts or the reaper job is about to run
- **THEN** a loud TTS and a desktop notification are emitted warning that the
  reaper may have been failing silently

#### Scenario: Healthy reaper stays silent

- **GIVEN** a successful `reaper` `cron_runs` row exists within the last 8
  days
- **WHEN** the cron service starts
- **THEN** no missed-run warning is emitted

