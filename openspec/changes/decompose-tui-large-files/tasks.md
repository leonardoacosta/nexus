# Implementation Tasks

<!-- beads:epic:nx-nmqr -->

## Refactor Batch

- [ ] [1.1] [P-1] Create `crates/nexus-tui/src/types/mod.rs` with domain-grouped submodules (search.rs, tabs.rs, stream_types.rs, screen.rs, palette.rs, project.rs, spec.rs, agent.rs, confirm.rs) and re-exports [owner:rust-engineer] [beads:nx-5v65]
- [ ] [1.2] [P-1] Move SearchState, CodeBlockRange to `types/search.rs` [owner:rust-engineer] [beads:nx-iarf]
- [ ] [1.3] [P-1] Move SessionTab to `types/tabs.rs` [owner:rust-engineer] [beads:nx-rd6o]
- [ ] [1.4] [P-1] Move StreamVerbosity, LineStyle, StyledLine, StreamLine to `types/stream_types.rs` [owner:rust-engineer] [beads:nx-j2o7]
- [ ] [1.5] [P-1] Move Screen, InputMode to `types/screen.rs` [owner:rust-engineer] [beads:nx-wray]
- [ ] [1.6] [P-1] Move PaletteAction, PaletteEntry to `types/palette.rs` [owner:rust-engineer] [beads:nx-zpb5]
- [ ] [1.7] [P-1] Move AgentData, SessionRow, AgentOfflineRow, ActivityStatus, SyncStatus, AgentHealthHistory to `types/agent.rs` [owner:rust-engineer] [beads:nx-loxz]
- [ ] [1.8] [P-1] Move ProjectSummary, ProjectDetail to `types/project.rs` [owner:rust-engineer] [beads:nx-zfhz]
- [ ] [1.9] [P-1] Move SpecListEntry, SpecDetailState to `types/spec.rs` [owner:rust-engineer] [beads:nx-3qjp]
- [ ] [1.10] [P-1] Move ConfirmKind to `types/confirm.rs` [owner:rust-engineer] [beads:nx-brqx]
- [ ] [1.11] [P-2] Update all import sites across nexus-tui to use `crate::types::*` or specific paths; verify `cargo check -p nexus-tui` passes [owner:rust-engineer] [beads:nx-yy95]

## Stream Decomposition Batch

- [ ] [2.1] [P-1] Convert `screens/stream.rs` to `screens/stream/mod.rs` directory module [owner:rust-engineer] [beads:nx-sut7]
- [ ] [2.2] [P-1] Extract header/metadata rendering into `screens/stream/header.rs` [owner:rust-engineer] [beads:nx-zdl0]
- [ ] [2.3] [P-1] Extract message/content area rendering into `screens/stream/content.rs` [owner:rust-engineer] [beads:nx-4e6k]
- [ ] [2.4] [P-1] Extract input/status bar rendering into `screens/stream/status.rs` [owner:rust-engineer] [beads:nx-hmnq]
- [ ] [2.5] [P-2] Reduce `render_stream` to coordinator calling widget builders; verify `cargo check -p nexus-tui` passes [owner:rust-engineer] [beads:nx-9d6p]

## Spec Watcher Decomposition Batch

- [ ] [3.1] [P-1] Extract hash-change detection logic (lines 234-263) into `fn handle_hash_change()` [owner:rust-engineer] [beads:nx-hhge]
- [ ] [3.2] [P-1] Extract task-progress detection logic (lines 267-326) into `fn handle_task_progress()` [owner:rust-engineer] [beads:nx-1rhq]
- [ ] [3.3] [P-1] Extract new-spec insertion logic (lines 338-368) into `fn handle_new_spec()` [owner:rust-engineer] [beads:nx-o7z5]
- [ ] [3.4] [P-1] Extract spec-removal detection logic (lines 376-394) into `fn handle_spec_removal()` [owner:rust-engineer] [beads:nx-asym]
- [ ] [3.5] [P-2] Refactor `process_project_specs` into dispatcher calling the 4 handlers; verify `cargo check -p nexus-agent` passes [owner:rust-engineer] [beads:nx-ko4z]

## Dead Code Cleanup Batch

- [ ] [4.1] [P-1] Remove `#[allow(dead_code)]` annotations from `get_session` (line 314) and `stop_session` (line 506) in client.rs — callers exist in main.rs and stream.rs [owner:rust-engineer] [beads:nx-zxxm]
- [ ] [4.2] [P-1] Remove `#[allow(dead_code)]` annotations from `get_health_time_series` (line 551), `get_session_history` (line 585), `get_failure_trends` (line 637), `get_spec_velocity` (line 699) in client.rs — callers exist in main.rs [owner:rust-engineer] [beads:nx-m7or]
- [ ] [4.3] [P-1] Remove `rename_pool_credential` function (~40 lines at line 958) from credential_pool.rs — zero callers [owner:rust-engineer] [beads:nx-c2ev]
- [ ] [4.4] [P-2] Run `cargo clippy -p nexus-tui -p nexus-agent` and `cargo test` to verify no regressions [owner:rust-engineer] [beads:nx-kgb7]
