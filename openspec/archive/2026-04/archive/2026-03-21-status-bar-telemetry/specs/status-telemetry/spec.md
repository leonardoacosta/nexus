## ADDED Requirements

### Requirement: Rate Limit Event Parsing

The agent parser SHALL parse `rate_limit_event` events from CC stream-json output and extract:
- `utilizationPercent` (float, 0.0 to 100.0)
- `rateLimitType` (string, e.g. "token", "request")
- `surpassedThreshold` (boolean)

The parser SHALL emit these values as a `RateLimitInfo` proto message rather than dropping
the event.

#### Scenario: Rate limit event parsed successfully

- **WHEN** the parser receives a stream-json line with `"type": "rate_limit_event"`
- **AND** the event contains `utilizationPercent`, `rateLimitType`, and `surpassedThreshold` fields
- **THEN** the parser extracts all three fields into a `RateLimitInfo` struct
- **AND** the rate limit info is stored against the current session in the registry

#### Scenario: Rate limit event with missing fields

- **WHEN** the parser receives a `rate_limit_event` with missing optional fields
- **THEN** the parser uses defaults (0.0 for utilization, empty string for type, false for surpassed)
- **AND** the event is not dropped

### Requirement: Cost and Model Extraction

The agent parser SHALL extract `total_cost_usd` (float) and `model` (string) from `result`
events in CC stream-json output.

The agent SHALL store the latest `total_cost_usd` and `model` per session in the registry.
Cost values SHALL be cumulative per session (each `result` event reports total cost for that
CC session).

#### Scenario: Result event with cost and model

- **WHEN** the parser receives a `result` event containing `total_cost_usd` and `model` fields
- **THEN** the session's stored cost is updated to the reported `total_cost_usd` value
- **AND** the session's stored model is updated to the reported `model` string

#### Scenario: Result event without cost or model

- **WHEN** the parser receives a `result` event that lacks `total_cost_usd` or `model`
- **THEN** existing session cost and model values are preserved (not cleared)
- **AND** the `CommandDone` message is still emitted normally

### Requirement: Proto Messages for Telemetry

The proto schema SHALL define:

- `RateLimitInfo` message with fields: `float utilization_percent`, `string rate_limit_type`,
  `bool surpassed_threshold`
- `SessionTelemetry` message with fields: `optional RateLimitInfo rate_limit`,
  `optional float total_cost_usd`, `optional string model`

The `Session` proto message SHALL include an optional `SessionTelemetry telemetry` field.

The `HealthResponse` proto message SHALL include an optional `RateLimitInfo latest_rate_limit`
field reflecting the most recent rate limit event across all active sessions.

#### Scenario: Session proto includes telemetry

- **WHEN** the TUI requests session data via `GetSessions` or `GetSession`
- **AND** rate limit or cost data has been captured for a session
- **THEN** the response includes a populated `SessionTelemetry` in the session's `telemetry` field

#### Scenario: Health response includes aggregate rate limit

- **WHEN** the TUI calls `GetHealth`
- **AND** at least one session has received a rate limit event
- **THEN** the `HealthResponse` includes `latest_rate_limit` with the most recent rate limit info

#### Scenario: No telemetry data available

- **WHEN** no sessions have emitted rate limit or cost events
- **THEN** `SessionTelemetry` fields are `None`/absent
- **AND** `HealthResponse.latest_rate_limit` is `None`/absent

### Requirement: Registry Telemetry Storage

The agent registry SHALL store per-session telemetry data (latest rate limit info, total cost,
model name) and provide methods to update and retrieve this data.

Telemetry updates SHALL be thread-safe (behind the existing registry lock).

#### Scenario: Telemetry updated during command execution

- **WHEN** the parser extracts rate limit or cost data during a `SendCommand` stream
- **THEN** the registry is updated with the new telemetry for that session
- **AND** subsequent `GetSession` calls reflect the updated telemetry

#### Scenario: Session removed cleans up telemetry

- **WHEN** a session is removed from the registry (unregister or stop)
- **THEN** its associated telemetry data is also removed

### Requirement: TUI Stream Status Bar Telemetry

The TUI stream view status bar SHALL display rate limit utilization and model information
when available for the attached session.

The status bar SHALL show:
- Model name (e.g. "opus-4" or "sonnet-4") when known
- Rate limit utilization percentage when available, with color coding:
  - Green (normal) below 50%
  - Yellow (warning) at 50-79%
  - Red (critical) at 80%+
- Cost in USD when available (e.g. "$1.23")

When no telemetry is available, the status bar SHALL display its current content
(event count and scroll indicator) without telemetry fields.

#### Scenario: Full telemetry displayed

- **WHEN** the stream view is attached to a session with rate limit and cost data
- **THEN** the status bar shows model name, rate limit percentage with color, and cost
- **AND** the existing event count and scroll indicator remain visible

#### Scenario: Partial telemetry displayed

- **WHEN** the stream view is attached to a session with only cost data (no rate limit)
- **THEN** the status bar shows cost and model but omits rate limit percentage
- **AND** the layout does not break

#### Scenario: No telemetry available

- **WHEN** the stream view is attached to a session with no telemetry data
- **THEN** the status bar shows only event count and scroll indicator (current behavior)
