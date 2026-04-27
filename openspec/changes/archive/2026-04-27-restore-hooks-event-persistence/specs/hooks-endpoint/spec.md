# hooks-endpoint Specification (delta)

## MODIFIED Requirements

### Requirement: POST /hooks Endpoint

nexus-agent SHALL expose a `POST /hooks` endpoint that accepts JSON payloads from Claude Code HTTP hooks and telemetry.sh, **persists each event to the `events` table**, dispatches based on `hook_event_name` or `event` field, and updates the `sessions` table for lifecycle events.

The endpoint MUST NOT regress to a "log-and-acknowledge" no-op pattern. Every recognized event type MUST produce at least one database write before returning 200 OK.

#### Scenario: Event row written for every recognized event
- **GIVEN** a payload with `hook_event_name: "session_start"`, `session_id: "abc-123"`, `project: "oo"`
- **WHEN** the handler processes the request
- **THEN** a row is inserted into the `events` table with `event_type='session_start'`, `session_id='abc-123'`, `project='oo'`, `timestamp=NOW()`
- **AND** the response is HTTP 200 with `{"status": "ok"}`

#### Scenario: Diagnostic ping is persisted
- **GIVEN** a payload with `hook_event_name: "diagnostic_ping"`, `session_id: "diag-test"`
- **WHEN** the handler processes the request
- **THEN** a row appears in the `events` table within 100ms
- **AND** `SELECT * FROM events WHERE event_type='diagnostic_ping'` returns at least one row

### Requirement: SessionSummary Event Type

nexus-agent SHALL support `session_summary` events that carry per-session monitoring data including tool usage counts, failure count, compaction count, agent spawn count, duration, model, **input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, and cost_usd**. Token and cost fields MAY be omitted by older callers; when present, they SHALL be persisted into the `sessions` table.

#### Scenario: Summary with cost data updates sessions table
- **GIVEN** session "abc-123" has an active row in the `sessions` table
- **AND** a payload with `event: "session_summary"`, `session_id: "abc-123"`, `output_tokens: 224148`, `cache_read_input_tokens: 14977166`, `cost_usd: 88.45`
- **WHEN** the handler processes the request
- **THEN** the sessions row's `total_cost_usd` becomes `88.45`
- **AND** if a `session_token_aggregates` table exists, per-turn rows are inserted

#### Scenario: Summary without explicit cost computes from tokens
- **GIVEN** a payload with `event: "session_summary"`, token fields populated, `model: "claude-opus-4-7"`, but NO `cost_usd` field
- **WHEN** the handler processes the request
- **THEN** the handler computes cost server-side using model-aware rates (Opus 4.7: $15/M input, $75/M output, $1.50/M cache_read, $30/M cache_write 1h)
- **AND** the computed value is stored in `total_cost_usd`

## ADDED Requirements

### Requirement: SessionStop Event Type

nexus-agent SHALL support `session_stop` events that finalize an active session. On receipt, `ended_at` SHALL be set to NOW() and `status` SHALL transition to `"ended"`.

#### Scenario: session_stop finalizes the session row
- **GIVEN** session "abc-123" has `status='active'` and `ended_at=NULL`
- **WHEN** a `session_stop` event arrives for `session_id: "abc-123"`
- **THEN** the sessions row is updated: `ended_at=NOW()`, `status='ended'`
- **AND** the events table also receives a row for the stop event

### Requirement: StopFailure Event Type

nexus-agent SHALL support `stop_failure` events that record session-level errors. On receipt, `status` SHALL transition to `"errored"` and the `stop_reason` field SHALL be persisted in the events row's data column.

#### Scenario: stop_failure marks session errored
- **GIVEN** session "abc-123" is active
- **WHEN** a `stop_failure` event arrives with `stop_reason: "api_error"`
- **THEN** the sessions row is updated: `status='errored'`, `ended_at=NOW()`
- **AND** the events row stores `stop_reason='api_error'` in its data column

### Requirement: Diagnostic Ping for Operability Verification

nexus-agent SHALL accept a `diagnostic_ping` event type whose sole purpose is round-trip persistence verification. Operators SHALL be able to send this event and confirm the write path is healthy.

#### Scenario: Diagnostic ping enables liveness check
- **GIVEN** an operator wants to verify nexus-agent persistence
- **WHEN** they POST `{"hook_event_name": "diagnostic_ping", "session_id": "diag-<timestamp>"}` to `/hooks`
- **THEN** within 1 second, `SELECT * FROM events WHERE event_type='diagnostic_ping' AND session_id='diag-<timestamp>'` returns the row
- **AND** the operator can use this as a smoke test in deployment scripts
