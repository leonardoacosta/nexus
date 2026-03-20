# Change: Implement agent health collection and session operations

## Why

The agent daemon needs to expose machine health metrics and support managed session
lifecycle (start/stop). Without health collection, the TUI Health screen has no data.
Without start/stop RPCs, the TUI cannot control sessions remotely. This is Phase 3,
Wave 3 — the final agent-side capability before the TUI can render all planned screens.

## What Changes

- Implement sysinfo-based machine health collection (CPU, RAM, disk, load avg, uptime)
- Add optional Docker container status detection via `docker ps` CLI
- Add HTTP `/health` endpoint on port 7401 (axum, JSON, curl-friendly)
- Implement `StopSession` gRPC RPC: SIGTERM → 10s wait → SIGKILL fallback
- Implement `StartSession` gRPC RPC: spawn Claude Code in tmux (`tmux new-session -d -s nx-<short-id> -- claude [args]`)
- Track managed sessions in registry with tmux_session metadata

## Impact

- Affected specs: agent-ops (NEW capability)
- Affected code: `crates/nexus-agent/src/health.rs`, `crates/nexus-agent/src/main.rs`, `crates/nexus-agent/src/grpc.rs`, `crates/nexus-agent/src/registry.rs`
- Depends on: proto-and-codegen (spec 2) and agent-grpc-server (spec 3) — needs gRPC server and protobuf types
- Depended on by: stream-events-rpc (spec 7)
- ~300 LOC estimated
