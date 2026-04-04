# Proposal: Refactor nexus-agent module structure

## Change ID
`refactor-agent-modules`

## Summary
Decompose the two largest files in nexus-agent — `grpc.rs` (1571 LOC) and `main.rs` (1138 LOC) —
into focused modules. Extract duplicated CC subprocess logic into a shared command executor.

## Context
- Extends: `crates/nexus-agent/src/grpc.rs`, `crates/nexus-agent/src/main.rs`
- Related: Audit finding — god-object risk, code duplication in command dispatch

## Motivation
`grpc.rs` contains 15 RPC implementations plus 3 command dispatch paths with duplicated CC
subprocess spawning logic. `main.rs` mixes HTTP handler functions with service wiring and startup
orchestration. Both files are hard to navigate and maintain. The duplication between `send_command`
and `send_command_via_pool` means bug fixes must be applied in two places.

## Requirements

### Req-1: Split grpc.rs by domain
Decompose into a `grpc/` module directory:
- `grpc/mod.rs` — NexusAgentService struct, new(), conversion helpers
- `grpc/sessions.rs` — GetSessions, GetSession, StartSession, StopSession, Register, Unregister, Heartbeat
- `grpc/commands.rs` — SendCommand, RunProjectCommand, send_command_via_pool, shared executor
- `grpc/status.rs` — GetProjectStatus, ListCommands, GetHealth, ListProjects, ListAgents
- `grpc/events.rs` — StreamEvents

### Req-2: Extract shared command executor
The CC subprocess spawn + stream-json parsing logic is duplicated between `send_command` (L319)
and `send_command_via_pool` (L1204). Extract into a shared `CommandExecutor` that both paths call.

### Req-3: Extract HTTP handlers from main.rs
Move all HTTP handler functions and their request/response types to a new
`crates/nexus-agent/src/http_handlers.rs`. `main.rs` retains only startup wiring and service
orchestration.

## Scope
- **IN**: grpc.rs split, shared executor extraction, HTTP handler extraction
- **OUT**: Logic changes, new features, API behavior changes

## Impact
| Area | Change |
|------|--------|
| crates/nexus-agent/src/grpc.rs | Split into grpc/ module directory (4-5 files) |
| crates/nexus-agent/src/main.rs | Extract HTTP handlers to http_handlers.rs |
| crates/nexus-agent/src/http_handlers.rs | New file — all axum handlers |
| crates/nexus-agent/src/lib.rs | Update module declarations |

## Risks
| Risk | Mitigation |
|------|-----------|
| Refactor introduces subtle behavior change | Pure structural move — no logic changes. Verify with `cargo test` |
| Import path changes break external consumers | nexus-agent is a binary crate, no external consumers |
