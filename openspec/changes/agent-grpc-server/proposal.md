# Change: Implement gRPC server and session file watcher in nexus-agent

## Why

The nexus-agent currently has stub files for routes, registry, and watcher. The PRD specifies
gRPC as the wire protocol. This spec replaces the axum HTTP scaffold with a tonic gRPC server
implementing the NexusAgent service (GetSessions, GetSession RPCs), adds a sessions.json file
watcher using the `notify` crate, and wires up a session registry backed by
`tokio::sync::RwLock<HashMap>`. This is the critical path for Phase 2 — without a working
agent, the TUI has nothing to connect to.

## What Changes

- Replace axum HTTP server scaffold with tonic gRPC server on port 7400
- Implement `NexusAgent` gRPC service with `GetSessions` and `GetSession` RPCs
- Implement sessions.json file watcher (inotify on Linux, FSEvents on macOS via `notify` crate)
- Implement session registry (`RwLock<HashMap<String, Session>>`) for ad-hoc session tracking
- Create `grpc.rs` (replaces `routes.rs`) with gRPC service implementation
- Wire gRPC server startup in `main.rs`
- Add `tonic` dependency to nexus-agent, keep `axum` for future HTTP /health endpoint (spec 5)

## Impact

- Affected specs: grpc-transport (MODIFIED — adds agent-side service implementation)
- Affected code: `crates/nexus-agent/src/{main.rs, grpc.rs, watcher.rs, registry.rs}`, `crates/nexus-agent/Cargo.toml`
- **BREAKING**: `routes.rs` is replaced by `grpc.rs` (routes.rs was a comment stub, no real code lost)
- Depends on: proto-and-codegen (spec 1) — needs .proto definitions and generated types
- Depended on by: agent-health-and-ops (spec 5)
- Phase 2, Wave 2 — estimated ~350 LOC
