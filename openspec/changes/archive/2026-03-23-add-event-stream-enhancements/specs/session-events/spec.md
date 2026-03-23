## ADDED Requirements

### Requirement: Event Type Filtering
The StreamEvents RPC SHALL accept an optional list of event types in the `EventFilter`.
When event types are specified, the server SHALL only emit events matching those types.
When the list is empty, the server SHALL emit all event types (backward compatible).

#### Scenario: Subscribe to status changes only
- **WHEN** a client calls StreamEvents with `event_types: [STATUS_CHANGED]`
- **THEN** only StatusChanged events are emitted on the stream
- **AND** Heartbeat, SessionStarted, and SessionStopped events are filtered out

#### Scenario: Subscribe with empty filter (default)
- **WHEN** a client calls StreamEvents with no event_types specified
- **THEN** all event types are emitted (backward compatible behavior)

### Requirement: Agent Name on Events
Every `SessionEvent` emitted by the agent SHALL include the `agent_name` field populated
with the agent's configured name from `AppState`.

#### Scenario: Event includes agent identity
- **WHEN** any session event is emitted
- **THEN** the `agent_name` field is populated with the emitting agent's name
- **AND** the consumer can identify which machine produced the event without tracking connection state

### Requirement: Initial Snapshot
When `initial_snapshot` is set to true in `EventFilter`, the server SHALL emit synthetic
`SessionStarted` events for all currently registered sessions before switching to live
broadcast events.

#### Scenario: Snapshot on connect
- **WHEN** a client calls StreamEvents with `initial_snapshot: true`
- **THEN** the server first emits a `SessionStarted` event for each session in the registry
- **AND** each snapshot event has `is_snapshot: true`
- **AND** after all snapshot events, live broadcast events begin streaming

#### Scenario: No snapshot by default
- **WHEN** a client calls StreamEvents without `initial_snapshot` (or set to false)
- **THEN** only live broadcast events are streamed (no snapshot)
