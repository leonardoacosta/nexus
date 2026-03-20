## Context

The TUI needs to communicate with nexus-agent instances running on remote machines over Tailscale.
Spec 1 (proto-and-codegen) defines the protobuf service and generates Rust client stubs via
tonic-build. This spec wires those stubs into a usable client layer that the TUI screens consume.

The existing `client.rs` is a two-line comment stub. The existing `reqwest` dependency was
placeholder and has never been used in any compiled code path.

## Goals / Non-Goals

- **Goal**: Working gRPC client that connects to N agents, aggregates sessions, handles failures
- **Goal**: Clean per-agent connection state tracking for UI display
- **Goal**: Async-friendly API that integrates with the tokio event loop
- **Non-Goal**: Reconnection backoff strategy (simple retry on next poll is sufficient for v1)
- **Non-Goal**: Streaming/WebSocket subscriptions (future spec)
- **Non-Goal**: mTLS or auth (Tailscale handles network-level auth)

## Decisions

### Connection Management

- **Decision**: One `NexusAgentClient` (tonic generated) per agent, created at startup
- **Alternative**: Lazy connect on first call -- rejected because startup is a natural place to
  discover unreachable agents
- **Rationale**: Agents are few (2-5 machines); holding persistent connections is cheap

### Timeout

- **Decision**: 2-second connection and request timeout
- **Rationale**: Matches the TUI dashboard refresh interval (2s). If an agent doesn't respond in
  time, mark it disconnected and move on -- the next poll cycle will retry.

### Error Handling

- **Decision**: Graceful degradation per-agent. A single unreachable agent does not block the
  entire session list.
- **Alternative**: Fail-fast if any agent is down -- rejected because multi-machine monitoring
  must tolerate partial failures.

### Dependency Change

- **Decision**: Remove `reqwest` from nexus-tui, add `tonic`
- **Rationale**: reqwest was placeholder for HTTP transport. gRPC replaces it entirely. No code
  uses reqwest today.

## Risks / Trade-offs

- **Risk**: proto-and-codegen not merged yet. **Mitigation**: This spec's tasks.md declares the
  dependency; implementation blocks until spec 1 lands.
- **Risk**: tonic client connects lazily by default (first RPC call triggers real connection).
  **Mitigation**: `connect_all()` performs a lightweight RPC (or `connect()`) at startup to
  surface reachability early.

## Open Questions

None -- design is straightforward given the proto definitions from spec 1.
