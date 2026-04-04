## 1. Event Broadcast System

- [x] 1.1 Create `crates/nexus-agent/src/events.rs` with `EventBroadcaster` struct wrapping `tokio::sync::broadcast::Sender<SessionEvent>`
- [x] 1.2 Implement `EventBroadcaster::new(capacity: usize)` — creates broadcast channel with 256 capacity
- [x] 1.3 Implement `EventBroadcaster::emit(&self, event: SessionEvent)` — sends event to all subscribers, logs warning if no receivers
- [x] 1.4 Implement `EventBroadcaster::subscribe(&self) -> broadcast::Receiver<SessionEvent>` — returns new receiver for a subscriber

## 2. Registry Event Emission

- [x] 2.1 Add `EventBroadcaster` field to `SessionRegistry` (via `Arc<EventBroadcaster>`)
- [x] 2.2 Modify `upsert_sessions()` to diff incoming sessions against existing: emit `SessionStarted` for new session IDs with full Session data
- [x] 2.3 Modify `upsert_sessions()` to emit `StatusChanged` when session status differs (old_status, new_status)
- [x] 2.4 Modify `upsert_sessions()` to emit `SessionStopped` for session IDs that disappeared from the new set
- [x] 2.5 Emit `HeartbeatReceived` on heartbeat updates (session_id only)

## 3. StreamEvents RPC

- [x] 3.1 Implement `stream_events` on `NexusAgentService` — subscribe to broadcast, wrap in `ReceiverStream`
- [x] 3.2 Apply `EventFilter` to each event: filter by session_id if set, filter by event type if set
- [x] 3.3 Handle `broadcast::error::RecvError::Lagged` — log warning, continue streaming (skip missed events)
- [x] 3.4 Clean up receiver when client disconnects (stream dropped)

## 4. Wiring

- [x] 4.1 Add `mod events` to `main.rs`
- [x] 4.2 Construct `EventBroadcaster` in `main()` and pass `Arc` to both registry and gRPC service
- [x] 4.3 Verify `SessionEvent` proto type is available from `nexus_core::proto` (from spec 1 codegen)

## 5. Verification

- [x] 5.1 `cargo build -p nexus-agent` compiles without errors
- [x] 5.2 `cargo clippy -p nexus-agent` passes with no warnings
- [x] 5.3 `cargo test -p nexus-agent` passes (if tests exist)
