# Implementation Tasks

<!-- beads:epic:TBD -->

## Dead Code Batch

- [ ] [1.1] [P-1] Delete `crates/nexus-agent/src/services/receiver/socket.rs` and remove `mod socket;` from `services/receiver/mod.rs` [owner:engineer]
- [ ] [1.2] [P-1] Remove `shared_config` and `reload_rx` fields from `ReceiverService` struct in `services/receiver/service.rs`, update constructors (`new`, `with_config`, `with_shared_config`) to stop storing them [owner:engineer]

## Async I/O Batch

- [ ] [2.1] [P-1] Replace `std::fs::read_to_string` with `tokio::fs::read_to_string` in GET /mode handler at `services/receiver/http_router.rs:665` [owner:engineer]
- [ ] [2.2] [P-1] Replace `std::fs::read_to_string` with `tokio::fs::read_to_string` in GET /messages handler at `services/receiver/http_router.rs:829` [owner:engineer]
- [ ] [2.3] [P-1] Replace `std::fs::read_dir` with `tokio::fs::read_dir` in gRPC ListProjects handler at `grpc/status.rs:141` [owner:engineer]
- [ ] [2.4] [P-2] Make `NotificationsConfig::load()` async, replace `std::fs::read_to_string` with `tokio::fs::read_to_string` at `config.rs:306`, update all callers [owner:engineer]
- [ ] [2.5] [P-2] Replace `std::fs::read_dir` and `std::fs::read_to_string` with tokio equivalents in `failures.rs:259,276` (`bootstrap_from_jsonl`) [owner:engineer]

## Shared Client Batch

- [ ] [3.1] [P-1] Create a shared `reqwest::Client` in `main.rs` at startup with sensible default timeout, add it to `AppState` [owner:engineer]
- [ ] [3.2] [P-1] Refactor `check_failure_spike` in `http_handlers.rs:465` to call `state.failure_buffer.query_http(1)` directly instead of self-HTTP loopback, removing the per-request client [owner:engineer]
- [ ] [3.3] [P-1] Update `relay_notification_to_peers` in `socket.rs:587` to accept and use the shared `reqwest::Client` instead of constructing per-call [owner:engineer]
- [ ] [3.4] [P-1] Update `send_batch` in `services/sync_telemetry.rs:129` to accept and use the shared `reqwest::Client` instead of constructing per-call [owner:engineer]
- [ ] [3.5] [P-1] Update credential push in `services/credential_watcher.rs:142` to accept and use the shared `reqwest::Client` instead of constructing per-call [owner:engineer]

## Error Handling Batch

- [ ] [4.1] [P-1] Replace `.unwrap()` on `serde_json::to_value()` at `http_handlers.rs:569,586,603,620` with `.map_err()` returning 500 Internal Server Error [owner:engineer]

## Verification Batch

- [ ] [5.1] Verify `cargo build -p nexus-agent` succeeds with no warnings related to dead code [owner:engineer]
- [ ] [5.2] Verify `cargo test -p nexus-agent` passes with no regressions [owner:engineer]
- [ ] [5.3] Verify `cargo clippy -p nexus-agent` produces no new warnings [owner:engineer]
