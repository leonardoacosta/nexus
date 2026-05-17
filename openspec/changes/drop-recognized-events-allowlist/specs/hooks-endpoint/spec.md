## MODIFIED Requirements

### Requirement: hook endpoint SHALL accept ANY event_type

The hooks endpoint (POST /hooks AND AF_UNIX socket dispatcher) SHALL NOT reject hook payloads based on `event_type`. The hardcoded `RECOGNIZED_EVENTS` set in `routes/hooks.ts` is removed. Unknown event types persist normally to `session_events` with the full raw payload.

#### Scenario: new event type persists
- **GIVEN** the allow-list is removed
- **WHEN** CC sends a payload with `event_type='WorkspaceChanged'` (not previously known)
- **THEN** one row appears in `session_events` with the full payload AND the schema-drift detector (P2.1) fires `HookSchemaDrift` for the new event type

### Requirement: session_events.metadata SHALL store the full raw payload

The `metadata` column on `session_events` SHALL contain `JSON.stringify(payload)` — the entire request body as received, not a filtered subset. No field-level filtering happens at the dispatch layer.

#### Scenario: payload round-trip preserves every field
- **GIVEN** a hook payload with 12 fields
- **WHEN** the dispatcher processes and persists the event
- **THEN** `SELECT metadata FROM session_events ORDER BY id DESC LIMIT 1` returns a JSON string containing all 12 fields with original values
