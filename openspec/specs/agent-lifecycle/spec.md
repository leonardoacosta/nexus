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

### Requirement: nexus-agent SHALL remain stable under heavy concurrent session load

The agent process MUST NOT crash (SIGABRT/SIGILL) under sustained heavy concurrent
multi-session load. Memory usage approaching the systemd `MemoryMax` cap MUST be diagnosable
(structured logging of memory pressure) rather than terminating via an uncaught native-level
abort with no diagnostic trail.

#### Scenario: Memory pressure is logged before a potential crash

- **GIVEN** the agent process's memory usage crosses 90% of its configured `MemoryMax`
- **WHEN** the next memory-sampling tick runs
- **THEN** a structured WARN-level log entry is emitted recording current usage and the cap
- **AND** this log entry exists in the process's log history even if the process subsequently
  crashes, giving the next investigation a diagnostic trail the 2026-07-12 incident lacked

