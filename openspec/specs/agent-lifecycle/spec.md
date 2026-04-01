# agent-lifecycle Specification

## Purpose
TBD - created by archiving change add-sqlite-consolidation. Update Purpose after archive.
## Requirements
### Requirement: The system MUST track agent start and stop events in SQLite
The agent MUST record startup and shutdown events to the `agent_lifecycle` table with timestamp, event type, version, uptime, and shutdown reason.

#### Scenario: Agent start recorded
Given the agent starts successfully
When initialization completes
Then a row is inserted with event_type="start", version from Cargo.toml, and current timestamp

#### Scenario: Agent graceful shutdown recorded
Given the agent receives SIGTERM
When the shutdown coordinator completes
Then a row is inserted with event_type="stop", uptime_seconds calculated from start time, and reason="sigterm"

#### Scenario: Uptime queryable
Given the agent has been running for 48 hours
When GET /analytics/lifecycle or the gRPC equivalent is called
Then the response shows current uptime and recent start/stop history

