# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Delete `SessionListResponse`, `RegisterSessionRequest`, `HeartbeatRequest`, `StopSessionRequest`, `SessionEvent` from `crates/nexus-core/src/api.rs` [owner:api-engineer]
- [ ] [1.2] [P-1] Remove unused `use crate::session::Session` import from api.rs if no longer needed [owner:api-engineer]
- [ ] [1.3] [P-2] Verify `HealthResponse` still compiles and is importable by nexus-agent [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Verify `cargo build` succeeds for all workspace crates [owner:e2e-engineer]
- [ ] [2.2] Verify `cargo clippy` reports no new warnings [owner:e2e-engineer]
