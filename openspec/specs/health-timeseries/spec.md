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

