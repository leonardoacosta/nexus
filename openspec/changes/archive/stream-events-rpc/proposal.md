# Change: Implement StreamEvents server-streaming gRPC RPC with event broadcast system

## Why

The TUI needs real-time session updates without polling. The proto definitions (spec 1) already
define the `StreamEvents` RPC and `SessionEvent` message types. The agent-grpc-server (spec 3)
implemented `GetSessions` and `GetSession` but left `StreamEvents` unimplemented. This spec adds
the event broadcast system that emits `SessionEvent` protobuf messages on session state changes
and delivers them to all connected TUI subscribers via server-streaming gRPC.

## What Changes

- Create `crates/nexus-agent/src/events.rs` (NEW) — event broadcast system using
  `tokio::sync::broadcast` for fan-out to multiple subscribers
- Modify `crates/nexus-agent/src/grpc.rs` — add `StreamEvents` RPC implementation that creates
  a broadcast receiver and streams `SessionEvent` messages through it
- Modify `crates/nexus-agent/src/registry.rs` — emit events on session state changes (new session
  detected, heartbeat received, status transitions, session disappeared)

## Impact

- Affected specs: grpc-transport (ADDED — streaming event delivery capability)
- Affected code: `crates/nexus-agent/src/{events.rs, grpc.rs, registry.rs}`
- No breaking changes — additive to existing gRPC service and registry
- Depends on: agent-health-and-ops (spec 5) — needs complete gRPC service and registry
- Depended on by: tui-attach-and-alerts (spec 9) — TUI subscribes to event streams
- Phase 4, Wave 4 — estimated ~250 LOC
