## 1. Proto Changes
- [x] 1.1 Add `repeated EventType event_types` to `EventFilter` in `proto/nexus.proto`
- [x] 1.2 Add `EventType` enum: `SESSION_STARTED`, `HEARTBEAT_RECEIVED`, `STATUS_CHANGED`, `SESSION_STOPPED`
- [x] 1.3 Add `string agent_name` field to `SessionEvent`
- [x] 1.4 Add `bool initial_snapshot` flag to `EventFilter`

## 2. Agent Implementation
- [x] 2.1 Update `StreamEvents` handler to filter by `event_types` when provided
- [x] 2.2 Populate `agent_name` on all emitted events from `NexusAgentService.agent_name`
- [x] 2.3 Implement initial snapshot: when `initial_snapshot=true`, emit `SessionStarted` for all current registry entries before subscribing to broadcast

## 3. Validation
- [x] 3.1 Test: event type filtering reduces noise (subscribe to StatusChanged only)
- [x] 3.2 Test: agent_name populated on all event variants
- [x] 3.3 Test: initial_snapshot delivers current state before live events
- [x] 3.4 `cargo clippy && cargo test` — 24 tests pass, 0 clippy errors
