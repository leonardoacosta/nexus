# Implementation Tasks

<!-- beads:epic:nexus-6hy -->

## Dead Code Batch

- [ ] [1.1] [P-1] Gate `pub mod imessage_reader;` in `services/mod.rs` with `#[cfg(target_os = "macos")]` [owner:engineer] [beads:nexus-vsl]
- [ ] [1.2] [P-1] Make `rusqlite` dependency optional in `crates/nexus-agent/Cargo.toml` behind a `macos` feature flag, gate any conditional `use` imports [owner:engineer] [beads:nexus-01w]
- [ ] [1.3] [P-1] Delete `remove_stale()` method and its `#[allow(dead_code)]` from `registry.rs:91-98` [owner:engineer] [beads:nexus-lca]

## Async Hygiene Batch

- [ ] [2.1] [P-1] Migrate `SyncTelemetryService::read_queue()` from `File::open`/`BufReader` to `tokio::fs::read_to_string` + line parsing or `spawn_blocking` [owner:engineer] [beads:nexus-46s]
- [ ] [2.2] [P-1] Migrate `SyncTelemetryService::requeue_events()` from `std::fs::write` to `tokio::fs::write` or `spawn_blocking` [owner:engineer] [beads:nexus-6c0]
- [ ] [2.3] [P-2] Update `flush()` recovery path to use async I/O for `std::fs::remove_file` and `std::fs::read_to_string` calls [owner:engineer] [beads:nexus-e6a]
- [ ] [2.4] [P-2] Verify all existing sync_telemetry tests pass after migration [owner:engineer] [beads:nexus-vdu]

## Socket Cleanup Batch

- [ ] [3.1] [P-1] Remove `cleanup_stale_socket(&path).await?;` at `socket.rs:100` inside `run_socket_service` (keep the one in `main.rs:105`) [owner:engineer] [beads:nexus-mzo]

## Home Dir Fix Batch

- [ ] [4.1] [P-1] Replace `std::env::var("HOME").ok().map(PathBuf::from)` at `cron.rs:359` with `nexus_core::paths::home_dir()` [owner:engineer] [beads:nexus-5wu]

## Clippy Lint Batch

- [ ] [5.1] [P-1] Run `cargo clippy --fix -p nexus-agent --allow-dirty` to auto-fix collapsible_if, manual_strip, derivable_impls, trim_before_split, map_or, or_insert_with [owner:engineer] [beads:nexus-4tu]
- [ ] [5.2] [P-1] Fix remaining non-auto-fixable lints manually: tabs_in_doc_comments (2x), if_same_then_else (2x), doc_list_item_without_indentation (2x), manual_char_comparison (1x), CronState Default impl (1x) [owner:engineer] [beads:nexus-cst]
- [ ] [5.3] [P-1] Fix the 1 `collapsible_if` in `crates/nexus-core/src/lifecycle.rs:227` [owner:engineer] [beads:nexus-yh2]

## Context Struct Batch

- [ ] [6.1] [P-2] Define `SocketContext` struct in `socket.rs` bundling registry, receiver, cancel, lifecycle_tx, notification_config, peer_relay_urls, failure_buffer, http_client [owner:engineer] [beads:nexus-5nd]
- [ ] [6.2] [P-2] Refactor `run_socket_service` and `handle_connection` to accept `SocketContext` instead of 8 individual params [owner:engineer] [beads:nexus-d0r]
- [ ] [6.3] [P-2] Update `main.rs` socket service call site to construct and pass `SocketContext` [owner:engineer] [beads:nexus-rwa]
- [ ] [6.4] [P-2] Define `AgentServiceConfig` struct in `grpc/mod.rs` bundling all 10 `NexusAgentService::new` params [owner:engineer] [beads:nexus-d1p]
- [ ] [6.5] [P-2] Refactor `NexusAgentService::new` to accept `AgentServiceConfig`, update `main.rs` call site [owner:engineer] [beads:nexus-2jm]

## Verification Batch

- [ ] [7.1] Verify `cargo build -p nexus-agent` succeeds [owner:engineer] [beads:nexus-zlm]
- [ ] [7.2] Verify `cargo test -p nexus-agent` passes with no regressions [owner:engineer] [beads:nexus-0xs]
- [ ] [7.3] Verify `cargo clippy -p nexus-agent` reports 0 warnings [owner:engineer] [beads:nexus-cc6]
- [ ] [7.4] Verify `cargo clippy` workspace-wide reports no new warnings [owner:engineer] [beads:nexus-7yt]
