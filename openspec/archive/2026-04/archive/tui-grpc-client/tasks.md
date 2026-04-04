## 1. Dependency Changes

- [x] 1.1 Add `tonic` to workspace `Cargo.toml` `[workspace.dependencies]` (if not already added by proto-and-codegen)
- [x] 1.2 Update `crates/nexus-tui/Cargo.toml`: add `tonic = { workspace = true }`, remove `reqwest = { workspace = true }`

## 2. Connection State Types

- [x] 2.1 Define `AgentConnection` struct in `client.rs`: agent name, host, port, user, connection status enum (Connected/Disconnected), last_seen timestamp, last error message
- [x] 2.2 Define `ConnectionStatus` enum: `Connected`, `Disconnected`

## 3. NexusClient Implementation

- [x] 3.1 Define `NexusClient` struct holding `Vec<AgentConnection>` and config
- [x] 3.2 Implement `NexusClient::new(config: NexusConfig)` -- initialize connections from agents.toml entries
- [x] 3.3 Implement `NexusClient::connect_all()` -- attempt tonic connection to each agent endpoint with 2s timeout
- [x] 3.4 Implement `NexusClient::get_sessions()` -- call `ListSessions` on all connected agents, aggregate results, return `Vec<(AgentInfo, Vec<Session>)>` with error status for unreachable agents
- [x] 3.5 Implement `NexusClient::get_session(id)` -- iterate agents to find session by ID, return `Option<(AgentInfo, Session)>`
- [x] 3.6 Implement `NexusClient::stop_session(id)` -- find owning agent, call `StopSession` RPC

## 4. Error Handling

- [x] 4.1 Implement graceful degradation: unreachable agents return empty session list with `Disconnected` status
- [x] 4.2 Update `last_seen` timestamp on successful responses
- [x] 4.3 Store last error message per agent on failure
- [x] 4.4 Log connection failures at `warn` level via `tracing`

## 5. Verification

- [x] 5.1 `cargo build -p nexus-tui` compiles without errors
- [x] 5.2 `cargo clippy -p nexus-tui` passes
- [x] 5.3 `cargo fmt --check` passes
