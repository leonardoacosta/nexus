# Proposal: chore(core): final polish — clippy, api.rs, socket types

## Change ID
`fix-core-final-polish`

## Summary
Consolidate 6 remaining nexus-core findings: fix collapsible-if clippy warning in lifecycle.rs, delete vestigial api.rs with dual HealthResponse, add Serialize to SocketCommand, define typed SocketResponse enum, fix f64-to-f32 proto cost precision loss, and split AgentInfo into identity + snapshot.

## Context
- Extends: `crates/nexus-core/src/lifecycle.rs`, `crates/nexus-core/src/api.rs`, `crates/nexus-core/src/socket_event.rs`, `crates/nexus-core/src/proto_convert.rs`, `crates/nexus-core/src/agent.rs`, `crates/nexus-core/src/lib.rs`, `proto/nexus.proto`
- Extends: `crates/nexus-agent/src/http_handlers.rs`, `crates/nexus-agent/src/socket.rs`
- Extends: `crates/nexus-tui/src/client.rs`, `crates/nexus-tui/src/app.rs`, `crates/nexus-tui/src/keys.rs`, `crates/nexus-tui/src/main.rs`, `crates/nexus-tui/src/screens/detail.rs`
- Related: `remove-dead-api-types` (retains HealthResponse; this spec deletes it and api.rs entirely), `fix-agent-final-cleanup` (covers lifecycle.rs collapsible-if as side-effect; this spec is the canonical owner), `refactor-centralize-proto-conversions` (covers proto From impls generally; this spec fixes the specific cost field precision issue)

## Motivation
Post-audit sweep found 6 findings in nexus-core that individually are small but collectively leave type safety gaps (untyped socket responses, missing Serialize), naming confusion (dual HealthResponse), silent precision loss (f64 truncated to f32 in proto), a clippy lint, and a mixed-concern struct. Cleaning them in one pass avoids 6 separate spec cycles.

## Requirements

### Req-1: Fix collapsible if in lifecycle.rs
The nested `if` at `lifecycle.rs:227-231` (`if *comp == "dev" { if let Some(project) = ... }`) SHALL be combined into a single let-chain expression using Rust 2024 edition syntax: `if *comp == "dev" && let Some(project) = components.get(i + 1)`.

### Req-2: Delete vestigial api.rs and inline HealthResponse
`api.rs` contains a single `HealthResponse` struct (14 lines) with only 1 consumer (`http_handlers.rs`). A separate `proto::HealthResponse` exists in the gRPC layer, creating naming confusion. The `api.rs` module SHALL be deleted from `lib.rs`. The HTTP handler in `http_handlers.rs` SHALL define `HealthResponse` locally as a private handler-scoped struct (it is only used by `health_handler`), or construct the response inline as a `serde_json::Value`.

### Req-3: Add Serialize derive to SocketCommand
`SocketCommand` at `socket_event.rs:10` only derives `Deserialize`, while its sibling `SocketEvent` derives both `Serialize` and `Deserialize`. `Serialize` SHALL be added to `SocketCommand` for symmetry and to enable logging/debugging of command payloads.

### Req-4: Define typed SocketResponse enum
The `dispatch_command` function in `socket.rs` returns `String` (ad-hoc JSON). A `SocketResponse` enum SHALL be defined in `nexus-core/src/socket_event.rs` with variants matching the 7 `SocketCommand` variants (e.g., `ModeQueryResult { mode: String }`, `HistoryResult { entries: Vec<...> }`, `Ok { message: String }` for mutations). The agent's `dispatch_command` SHALL return `SocketResponse` and serialize it at the socket boundary.

### Req-5: Fix f64-to-f32 cost precision loss in proto
`proto_convert.rs:103` casts `session.total_cost_usd` (f64) to f32 via `c as f32`, and line 162 casts back via `c as f64`. The proto field `total_cost_usd` in `SessionTelemetry` (nexus.proto) SHALL be changed from `float` to `double` to match the domain model's f64. The `as f32` / `as f64` casts in proto_convert.rs SHALL be removed.

### Req-6: Split AgentInfo into AgentIdentity + AgentSnapshot
`AgentInfo` in `agent.rs` mixes identity fields (`name`, `host`, `port`, `os`) with aggregated state (`sessions: Vec<Session>`, `health: Option<MachineHealth>`, `connected: bool`). It SHALL be split into `AgentIdentity` (name, host, port, os) and `AgentSnapshot` (identity: AgentIdentity, sessions, health, connected). All consumers in nexus-tui SHALL be updated. A type alias `type AgentInfo = AgentSnapshot` MAY be provided temporarily for migration ease but SHALL be removed before merge.

## Scope
- **IN**: The 6 findings listed above, scoped to nexus-core with cascading changes to nexus-agent and nexus-tui
- **OUT**: Other clippy lints in nexus-agent (covered by `fix-agent-final-cleanup`), other proto conversion improvements (covered by `refactor-centralize-proto-conversions`), gRPC HealthResponse changes (proto schema for health is fine), socket event restructuring beyond adding SocketResponse

## Impact
| Area | Change |
|------|--------|
| `nexus-core/src/lifecycle.rs` | Combine nested if into let-chain (1 line) |
| `nexus-core/src/api.rs` | Delete file entirely |
| `nexus-core/src/lib.rs` | Remove `pub mod api;` line |
| `nexus-core/src/socket_event.rs` | Add `Serialize` to SocketCommand; add `SocketResponse` enum |
| `nexus-core/src/proto_convert.rs` | Remove f32 casts on cost field |
| `nexus-core/src/agent.rs` | Split into `AgentIdentity` + `AgentSnapshot` |
| `proto/nexus.proto` | Change `total_cost_usd` from `float` to `double` in SessionTelemetry |
| `nexus-agent/src/http_handlers.rs` | Inline or localize HealthResponse struct |
| `nexus-agent/src/socket.rs` | Return `SocketResponse` from `dispatch_command` |
| `nexus-tui/src/client.rs` | Update AgentInfo usage to AgentSnapshot |
| `nexus-tui/src/app.rs` | Update AgentInfo usage to AgentSnapshot |
| `nexus-tui/src/keys.rs` | Update AgentInfo usage to AgentSnapshot |
| `nexus-tui/src/main.rs` | Update AgentInfo usage to AgentSnapshot |
| `nexus-tui/src/screens/detail.rs` | Update AgentInfo usage to AgentSnapshot |

## Risks
| Risk | Mitigation |
|------|-----------|
| Changing proto `float` to `double` breaks wire compatibility with running agents | Both agents and TUI are deployed together; no third-party consumers. Coordinated deploy. |
| AgentInfo split touches 12+ files in TUI | Provide temporary type alias during migration; grep confirms all usage sites |
| SocketResponse enum design may not cover all response shapes | Audit every `dispatch_command` arm and `mode_query_json`/`history_json` return types before defining variants |
| Overlap with `fix-agent-final-cleanup` on lifecycle.rs clippy | That spec's scope statement says "one nexus-core clippy fix in lifecycle.rs" — remove it from that spec's scope to avoid double-application |
| Overlap with `remove-dead-api-types` on api.rs | That spec retains HealthResponse; this spec supersedes it for api.rs deletion. Apply this spec after or instead of that one. |
