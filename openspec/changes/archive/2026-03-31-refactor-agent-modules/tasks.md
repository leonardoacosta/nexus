# Implementation Tasks

<!-- beads:epic:TBD -->

## DB Batch

- [x] [1.1] [P-1] Create `crates/nexus-agent/src/grpc/mod.rs` — move NexusAgentService struct, new(), conversion helpers (session_to_proto, datetime_to_timestamp, etc.) [owner:db-engineer]
- [x] [1.2] [P-2] Create `crates/nexus-agent/src/grpc/sessions.rs` — move GetSessions, GetSession, StartSession, StopSession, RegisterSession, UnregisterSession, Heartbeat [owner:db-engineer]
- [x] [1.3] [P-2] Create `crates/nexus-agent/src/grpc/commands.rs` — move SendCommand, RunProjectCommand, send_command_via_pool [owner:db-engineer]
- [x] [1.4] [P-2] Create `crates/nexus-agent/src/grpc/status.rs` — move GetProjectStatus, ListCommands, GetHealth, ListProjects, ListAgents [owner:db-engineer]
- [x] [1.5] [P-2] Create `crates/nexus-agent/src/grpc/events.rs` — move StreamEvents [owner:db-engineer]

## API Batch

- [x] [2.1] [P-1] Extract shared `CommandExecutor` — CC subprocess spawn, stream-json parsing, output relay. Used by both send_command and send_command_via_pool [owner:api-engineer]
- [x] [2.2] [P-1] Create `crates/nexus-agent/src/http_handlers.rs` — move all axum handler fns + request/response types from main.rs [owner:api-engineer]
- [x] [2.3] [P-2] Update `main.rs` to import from new modules — only wiring, startup, service spawn logic remains [owner:api-engineer]
- [x] [2.4] [P-2] Update `lib.rs` module declarations (replace `pub mod grpc` with directory module, add `pub mod http_handlers`) [owner:api-engineer]

## E2E Batch

- [x] [4.1] Verify `cargo test -p nexus-agent --lib` passes with identical test count before and after refactor [owner:api-engineer]
- [x] [4.2] Verify `cargo clippy -p nexus-agent` produces no new warnings [owner:api-engineer]
- [x] [4.3] Verify running binary serves all HTTP and gRPC endpoints correctly (smoke test) [owner:api-engineer]
