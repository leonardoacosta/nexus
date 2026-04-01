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

