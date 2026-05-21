# spec-watcher Specification Delta

## ADDED Requirements

### Requirement: Agent exposes active wave-plan status via /wave-plans/active

The agent SHALL expose `GET /wave-plans/active` returning the current
in-flight `/apply` or `/apply:all` run's wave-plan projection. The
response MUST include per-spec status entries with wave number, phase,
status enum, and dispatch timestamp.

#### Scenario: active run returns full projection

- **GIVEN** the agent's local `docs/apply/active.txt` points to a
  valid run id AND `docs/apply/<run-id>/wave-plan.json` is readable
- **WHEN** the dashboard fetches `GET /wave-plans/active`
- **THEN** the response status is 200
- **AND** the body contains `runId`, `planName`, `status`,
  `currentWave`, `currentPhase`, and `specStatuses[]`
- **AND** each `specStatuses[]` entry has `name`, `wave`, `status`,
  `phase`, `dispatchedAt` (nullable)

#### Scenario: no active run returns empty payload

- **WHEN** `docs/apply/active.txt` does not exist
- **THEN** the response is 200 with body
  `{runId: null, specStatuses: []}`
- **AND** no fields are omitted (downstream clients can rely on the
  shape)

#### Scenario: malformed wave plan does not crash agent

- **GIVEN** `docs/apply/<run-id>/wave-plan.json` exists but is
  malformed JSON or missing required keys
- **WHEN** the agent reads it
- **THEN** the response is 200 with body
  `{runId: null, specStatuses: [], error: "<reason>"}`
- **AND** an os_log warn is emitted with the parse error
- **AND** the agent does NOT throw

#### Scenario: spec status values are canonical

- **WHEN** the wave plan's internal status is one of
  `queued|dispatched|in_progress|completed|failed|skipped`
- **THEN** the wire's `specStatuses[].status` field MUST emit one of
  those values
- **AND** unknown internal statuses fall back to `queued`
