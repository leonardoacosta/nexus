# spec-timeseries Specification

## Purpose
TBD - created by archiving change add-sqlite-analytics. Update Purpose after archive.
## Requirements
### Requirement: The system MUST record spec task completion snapshots over time
The spec watcher MUST insert a timestamped snapshot into `spec_snapshots` for each spec on every poll cycle where task counts have changed, enabling delivery velocity analysis.

#### Scenario: Task progress recorded
Given spec "oo/add-user-auth" was at 5/12 tasks last snapshot
When the current poll finds 8/12 tasks
Then a new spec_snapshots row is inserted with completed=8, total=12, and current timestamp

#### Scenario: No change skips insert
Given spec "oo/add-user-auth" is still at 8/12 tasks
When the current poll finds the same count
Then no new snapshot row is inserted (avoids bloat)

