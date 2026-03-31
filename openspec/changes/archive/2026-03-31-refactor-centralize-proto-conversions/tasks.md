# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Add `tmux_target` optional string field to proto Session message if missing [owner:api-engineer]
- [ ] [1.2] [P-1] Create `crates/nexus-core/src/proto_convert.rs` with `From<Session> for proto::Session` and `From<proto::Session> for Session` [owner:api-engineer]
- [ ] [1.3] [P-1] Add `From<MachineHealth> for proto::MachineHealth` and reverse in proto_convert.rs [owner:api-engineer]
- [ ] [1.4] [P-1] Add `From<SessionStatus>`, `From<CommandInfo>` and timestamp conversions in proto_convert.rs [owner:api-engineer]
- [ ] [1.5] [P-2] Map `session_type` correctly using proto enum variants instead of hardcoding AdHoc [owner:api-engineer]
- [ ] [1.6] [P-2] Replace agent `session_to_proto`, `session_status_to_proto`, `datetime_to_timestamp`, `command_info_to_proto` with core `From` calls [owner:api-engineer]
- [ ] [1.7] [P-2] Replace TUI `proto_to_session`, `proto_to_machine_health`, `proto_timestamp_to_datetime` with core `From` calls [owner:api-engineer]
- [ ] [1.8] [P-2] Add unit tests for round-trip conversion of Session, MachineHealth, CommandInfo [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Verify `cargo build` succeeds for all workspace crates [owner:e2e-engineer]
- [ ] [2.2] Verify `cargo test` passes with new conversion tests [owner:e2e-engineer]
- [ ] [2.3] Verify `cargo clippy` reports no new warnings [owner:e2e-engineer]
