# Implementation Tasks

<!-- beads:epic:TBD -->

## API Batch

- [ ] [1.1] [P-1] Convert `send_batch_blocking` to async `send_batch` using `reqwest::Client` in `crates/nexus-agent/src/services/sync_telemetry.rs` [owner:api-engineer]
- [ ] [1.2] [P-1] Remove `spawn_blocking` wrapper around the HTTP send call in `send_batch` [owner:api-engineer]
- [ ] [1.3] [P-1] Remove `blocking` feature from reqwest dependency in `crates/nexus-agent/Cargo.toml` [owner:api-engineer]
- [ ] [1.4] [P-2] Verify `cargo build -p nexus-agent` compiles without the blocking feature [owner:api-engineer]
- [ ] [1.5] [P-2] Verify `cargo test -p nexus-agent` passes [owner:api-engineer]
