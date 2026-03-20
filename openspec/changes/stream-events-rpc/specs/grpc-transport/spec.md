## ADDED Requirements

### Requirement: Event Broadcast System

The agent SHALL maintain an event broadcast system using `tokio::sync::broadcast` that delivers
`SessionEvent` protobuf messages to all connected subscribers. The broadcast channel SHALL have a
capacity of 256 messages. If a subscriber falls behind, it SHALL receive a `Lagged` error and
skip missed events.

#### Scenario: Multiple subscribers receive same event

- **WHEN** two TUI clients are subscribed to `StreamEvents`
- **AND** a new session is detected by the file watcher
- **THEN** both subscribers SHALL receive a `SessionStarted` event with the full session data

#### Scenario: Slow subscriber receives lagged error

- **WHEN** a subscriber falls more than 256 events behind the broadcast head
- **THEN** the subscriber SHALL receive a `Lagged` error indicating the number of skipped messages
- **AND** streaming SHALL continue with the next available event

### Requirement: Session State Change Events

The registry SHALL emit `SessionEvent` messages at these state change points:

- `SessionStarted`: when a new session ID appears in the registry (carries full `Session` data)
- `HeartbeatReceived`: when a session heartbeat is updated (carries `session_id` only)
- `StatusChanged`: when a session transitions between statuses (carries `session_id`, `old_status`, `new_status`)
- `SessionStopped`: when a session ID disappears from the registry (carries `session_id` and `reason`)

#### Scenario: New session detected via file watcher

- **WHEN** the file watcher detects a new session in `sessions.json`
- **AND** the registry upserts the new session
- **THEN** a `SessionStarted` event SHALL be emitted with the complete session protobuf message

#### Scenario: Session status transition

- **WHEN** a session transitions from `ACTIVE` to `IDLE` (heartbeat age crosses 60s threshold)
- **THEN** a `StatusChanged` event SHALL be emitted with `old_status = ACTIVE` and `new_status = IDLE`

#### Scenario: Session disappears from sessions.json

- **WHEN** a previously tracked session ID is absent from the latest `sessions.json` parse
- **THEN** a `SessionStopped` event SHALL be emitted with the missing session's ID

#### Scenario: Alert-worthy status transitions

- **WHEN** a session transitions to `STALE` or `ERRORED` status
- **THEN** the `StatusChanged` event SHALL be emitted with the new status
- **AND** downstream consumers (TUI) can treat these as alert-worthy events

### Requirement: StreamEvents RPC

The `NexusAgent` gRPC service SHALL implement the `StreamEvents(EventFilter) returns (stream SessionEvent)` RPC as a server-streaming endpoint. Each call creates a new broadcast receiver and streams events through it until the client disconnects.

#### Scenario: Subscribe to all events

- **WHEN** a TUI client calls `StreamEvents` with an empty `EventFilter`
- **THEN** the client SHALL receive all `SessionEvent` messages as they occur
- **AND** the stream remains open until the client disconnects

#### Scenario: Filter by session_id

- **WHEN** a TUI client calls `StreamEvents` with `EventFilter { session_id: "abc-123" }`
- **THEN** the client SHALL only receive events where the event's session_id matches `"abc-123"`
- **AND** events for other sessions SHALL be silently dropped

#### Scenario: Client disconnects cleanly

- **WHEN** a TUI client drops the gRPC stream connection
- **THEN** the server SHALL drop the broadcast receiver for that client
- **AND** no resources SHALL leak from the disconnected subscriber

#### Scenario: No subscribers connected

- **WHEN** an event is emitted but no TUI clients are subscribed
- **THEN** the event SHALL be silently discarded
- **AND** no error SHALL occur in the agent
