# tui-analytics-wiring Specification

## Purpose
Wire the 4 analytical gRPC RPCs into the TUI client, state, and screens.

## ADDED Requirements

### Requirement: The TUI MUST expose client methods for all 4 analytical RPCs
NexusClient MUST implement get_session_history(), get_failure_trends(), get_health_time_series(),
and get_spec_velocity() methods that fan out across all connected agents and aggregate results.

#### Scenario: Health timeseries aggregated from multiple agents
Given 2 agents are connected, each with 24h of health data
When the TUI calls get_health_time_series(hours=24)
Then it returns merged timeseries entries from both agents, tagged by agent name

#### Scenario: Agent unreachable during analytics fetch
Given agent-1 is connected and agent-2 is unreachable
When the TUI calls get_spec_velocity(days=7)
Then it returns data from agent-1 only, logs a warning for agent-2, does not error

### Requirement: The TUI MUST use hybrid fetch strategy
Health timeseries MUST be fetched on a 30s background timer. Session history, failure trends, and
spec velocity MUST be fetched on-demand when the user navigates to the consuming screen.

#### Scenario: Health data refreshed in background
Given the TUI is running on the Dashboard screen (not Health)
When 30s elapses
Then get_health_time_series is called and App cache is updated

#### Scenario: Spec velocity fetched on screen entry
Given the user is on Dashboard and navigates to Specs screen
When the Specs screen activates
Then get_spec_velocity is triggered via RpcCommand and cache is populated

#### Scenario: Cached data shown while refreshing
Given the user navigates to Projects and cached spec_velocity exists from 45s ago
When the screen renders
Then it shows cached data immediately and triggers a background refresh

### Requirement: Health screen MUST show SQLite-backed 24h sparklines
The Health screen MUST replace or supplement the in-memory ring buffer sparklines with
GetHealthTimeSeries data for 24h history per agent.

#### Scenario: Historical sparkline on first render
Given the TUI just started and has no ring buffer data yet
When the user views the Health screen
Then sparklines show 24h of SQLite-backed data (not empty)

### Requirement: Dashboard MUST show session trends and failure indicator
The Dashboard status area MUST include a session count sparkline and failure count badge.

#### Scenario: Session trend in status bar
Given GetSessionHistory returns 7 days of session counts
When the Dashboard renders
Then a sparkline showing daily session counts appears in the status area

### Requirement: Projects screen MUST show spec velocity per project
Each project row MUST show spec completion progress from GetSpecVelocity data.

#### Scenario: Velocity column populated
Given GetSpecVelocity returns data for project "nx" with 3 specs at various completion levels
When the Projects screen renders
Then the nx row shows aggregated task completion ratio

### Requirement: Specs screen MUST show task completion velocity inline
Each spec row MUST show velocity trend alongside existing tasks_done/tasks_total counts.

#### Scenario: Velocity trend inline
Given GetSpecVelocity returns 5 snapshots for spec "add-user-auth" over 3 days
When the Specs screen renders
Then a mini sparkline or trend indicator appears next to the task progress
