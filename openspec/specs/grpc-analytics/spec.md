# grpc-analytics Specification

## Purpose
TBD - created by archiving change add-sqlite-consolidation. Update Purpose after archive.
## Requirements
### Requirement: The system MUST expose analytical RPCs over gRPC for TUI consumption
The agent MUST provide GetSessionHistory, GetFailureTrends, GetHealthTimeSeries, and GetSpecVelocity gRPC RPCs that query SQLite and return structured analytical data, enabling the TUI to query any agent's history over the existing gRPC channel.

#### Scenario: GetSessionHistory returns recent sessions
Given 50 sessions have been recorded in the past 7 days
When the TUI calls GetSessionHistory with days=7
Then the response contains session records with id, project, duration, cost, model, and timestamps

#### Scenario: GetFailureTrends returns tool failure aggregation
Given failures have been recorded over the past 30 days
When the TUI calls GetFailureTrends with days=30
Then the response contains per-tool failure counts and daily trend data

#### Scenario: GetHealthTimeSeries returns sampled metrics
Given health samples exist for the past 24 hours
When the TUI calls GetHealthTimeSeries with hours=24
Then the response contains timestamped CPU, memory, disk, and load samples

#### Scenario: GetSpecVelocity returns delivery metrics
Given spec snapshots exist for project "oo" over the past 30 days
When the TUI calls GetSpecVelocity with project="oo" and days=30
Then the response contains per-spec task completion timeseries data

