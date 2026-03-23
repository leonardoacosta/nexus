# Change: Enhance StreamEvents for External Consumers

## Why
Nova (and future clients beyond the TUI) needs to subscribe to real-time session lifecycle events.
The `StreamEvents` RPC exists but lacks event-type filtering and agent metadata — forcing consumers
to do client-side filtering and track which agent connection emitted each event.

## What Changes
- Add `event_types` filter to `EventFilter` proto so consumers can subscribe to only the events
  they care about (e.g., StatusChanged + SessionStopped, skip Heartbeat noise)
- Add `agent_name` field to `SessionEvent` proto so events are self-describing (no need to track
  which gRPC connection produced them)
- Add `initial_snapshot` flag to `EventFilter` — when true, the stream begins with synthetic
  `SessionStarted` events for all current sessions before switching to live events

## Impact
- Affected specs: `session-events` (new capability spec)
- Affected code: `proto/nexus.proto`, `crates/nexus-agent/src/grpc.rs` (StreamEvents handler)
- **Proto change** — requires regenerating gRPC stubs in both nx and nv
- Non-breaking: new fields are optional, existing consumers unaffected
