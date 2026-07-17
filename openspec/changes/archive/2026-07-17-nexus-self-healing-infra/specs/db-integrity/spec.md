## ADDED Requirements

### Requirement: A weekly cron job SHALL scan for known bad-data patterns and alert (detect-only)

The nexus-agent `CronService` SHALL register a `data-integrity` job (weekly, following the
existing `drift`/`reaper` cadence pattern) that runs read-only queries for known bad-data
signatures — starting with the projects-table duplicate-row pattern from the migration-0049
incident (multiple `projects` rows resolving to what should be a unique project identity). The
job MUST NOT modify any row. On a match, it emits a notification naming the affected table, the
matched rows/count, and the manual repair command an operator should run. Results persist to
`cron_runs` (`job="data-integrity"`) following the existing reaper/drift persistence shape.

#### Scenario: No duplicates found

- **GIVEN** the `projects` table has no rows matching the known duplicate signature
- **WHEN** the `data-integrity` job runs
- **THEN** a `cron_runs` row is written with `job="data-integrity"`, `status="success"`,
  `details` recording zero findings
- **AND** no notification is emitted
- **AND** no row in any table is modified

#### Scenario: Duplicate projects detected

- **GIVEN** the `projects` table contains multiple rows that match the known duplicate-identity
  signature
- **WHEN** the `data-integrity` job runs
- **THEN** a notification fires naming `projects`, the number of duplicate groups found, and the
  manual dedup command (mirroring the migration-0049 remediation)
- **AND** the job performs zero writes against `projects` or any other table
- **AND** a repeat run within the notification cooldown window does not re-fire the same alert

#### Scenario: Scan query fails (e.g. DB connection drop)

- **GIVEN** the underlying integrity query throws (connection error, timeout)
- **WHEN** the `data-integrity` job runs
- **THEN** the error is logged and a `cron_runs` row is written with `status="failure"`
- **AND** the failure does not crash the agent process or block other scheduled cron jobs
