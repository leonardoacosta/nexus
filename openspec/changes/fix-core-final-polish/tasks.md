# Implementation Tasks

<!-- beads:epic:nexus-r2m -->

## Core Batch

- [ ] [1.1] [P-1] Fix collapsible if in lifecycle.rs:227 — combine nested if into let-chain (`if *comp == "dev" && let Some(project) = ...`) [owner:core-engineer] [beads:nexus-4st]
- [ ] [1.2] [P-1] Delete `crates/nexus-core/src/api.rs` and remove `pub mod api;` from `lib.rs` [owner:core-engineer] [beads:nexus-zka]
- [ ] [1.3] [P-1] Add `Serialize` derive to `SocketCommand` enum in `socket_event.rs:10` [owner:core-engineer] [beads:nexus-1vq]
- [ ] [1.4] [P-2] Define `SocketResponse` enum in `socket_event.rs` with typed variants for all 7 command responses (audit `mode_query_json`, `mode_set_json`, `mode_cycle_json`, `history_json`, `type_set_json`, `type_clear_json`, notification handlers) [owner:core-engineer] [beads:nexus-deu]
- [ ] [1.5] [P-2] Change `total_cost_usd` from `float` to `double` in `proto/nexus.proto` SessionTelemetry message; remove `as f32` cast at `proto_convert.rs:103` and `as f64` cast at `proto_convert.rs:162` [owner:core-engineer] [beads:nexus-kbt]
- [ ] [1.6] [P-2] Split `AgentInfo` in `agent.rs` into `AgentIdentity` (name, host, port, os) and `AgentSnapshot` (identity, sessions, health, connected); add temporary `type AgentInfo = AgentSnapshot` alias [owner:core-engineer] [beads:nexus-qpe]

## Agent Batch

- [ ] [2.1] [P-1] Inline `HealthResponse` struct in `http_handlers.rs` as a private handler-scoped type (replace `use nexus_core::api::HealthResponse`) [owner:agent-engineer] [beads:nexus-m8b]
- [ ] [2.2] [P-2] Update `dispatch_command` in `socket.rs` to return `SocketResponse` enum and serialize at the write boundary [owner:agent-engineer] [beads:nexus-s8s]

## TUI Batch

- [ ] [3.1] [P-2] Update all `AgentInfo` imports and usages in `client.rs`, `app.rs`, `keys.rs`, `main.rs`, `screens/detail.rs` to use `AgentSnapshot` (or `AgentIdentity` where only identity fields are needed) [owner:tui-engineer] [beads:nexus-30u]
- [ ] [3.2] [P-3] Remove temporary `type AgentInfo = AgentSnapshot` alias from `agent.rs` after all TUI call sites are migrated [owner:tui-engineer] [beads:nexus-b5k]

## Validation Batch

- [ ] [4.1] Run `cargo clippy --workspace` and verify zero warnings related to these changes [owner:core-engineer] [beads:nexus-p4l]
- [ ] [4.2] Run `cargo test --workspace` and verify all tests pass [owner:core-engineer] [beads:nexus-29f]
- [ ] [4.3] Run `cargo build --workspace` to confirm proto regeneration succeeds with double field [owner:core-engineer] [beads:nexus-z41]
