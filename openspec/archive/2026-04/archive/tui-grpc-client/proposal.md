# Change: Replace HTTP client with tonic gRPC client in nexus-tui

## Why

The TUI currently stubs out an HTTP client (reqwest) for agent communication. The PRD mandates
gRPC as the wire protocol. With proto definitions and codegen landing in spec 1
(proto-and-codegen), the TUI can now implement a proper `NexusAgentClient` that connects to all
configured agents, handles disconnections gracefully, and exposes async methods the screens need.

## What Changes

- **Rewrite** `crates/nexus-tui/src/client.rs` from a comment stub into a full gRPC client
  module (~200 LOC)
- **Modify** `crates/nexus-tui/Cargo.toml`: add `tonic` dependency, remove `reqwest`
- Parse `agents.toml` via existing `NexusConfig::load()` from nexus-core
- Implement `AgentConnection` struct tracking per-agent connection state (connected/disconnected,
  last_seen, error)
- Implement `NexusClient` that manages connections to all agents and provides:
  - `get_sessions()` -> aggregate sessions from all agents
  - `get_session(id)` -> fetch a single session by ID
  - `stop_session(id)` -> request session stop on the owning agent
- Handle connection failures with 2s timeout, return empty session lists with error status for
  unreachable agents
- Track connection state per agent: connected, disconnected, last_seen timestamp, last error

## Impact

- Affected specs: grpc-transport (MODIFIED -- adds TUI client capability)
- Affected code: `crates/nexus-tui/src/client.rs` (rewrite), `crates/nexus-tui/Cargo.toml` (modify)
- **BREAKING**: Removes reqwest dependency from nexus-tui (no runtime impact -- client.rs was a stub)
- Phase 2, Wave 2
- Depends on: spec 1 (proto-and-codegen) -- needs generated `NexusAgentClient` stubs
- Depended on by: spec 6 (tui-screens-and-aggregation) -- screens consume this client
