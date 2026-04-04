# Fix Rust Async I/O — Replace std::fs with tokio::fs in Async Contexts

## Why
The nexus-agent daemon is fully async (tokio runtime) but contains ~20 blocking `std::fs` calls
inside async functions. Each one briefly stalls the tokio thread it executes on, reducing
throughput under concurrent load and introducing latency spikes. The worst offenders are
`sync_telemetry.rs` (read_to_string in async flush), `server_monitor.rs` (multiple fs calls in
collect_health), `socket.rs` (remove_file during shutdown), and `credential_pool.rs` (read_dir
in async event handlers). `icons.rs` is the largest cluster with ~10 blocking calls in
async-adjacent icon management code.

## What Changes
Replace all `std::fs::` calls that execute within `async fn` bodies or are called directly from
async task closures with their `tokio::fs::` equivalents. Where tokio::fs doesn't provide an
equivalent (e.g. complex sync iterators), wrap with `tokio::task::spawn_blocking`. Functions that
are genuinely sync (initialization, CLI setup, test helpers) are left unchanged.

## Scope (BLOCKING priority only)
- **sync_telemetry.rs**: `read_to_string` in `async fn flush()` (line 143)
- **server_monitor.rs**: `read_to_string` × 2, `write`, `create_dir_all` in `collect_health()` / `start()` (lines 182, 195, 272, 318)
- **launchd_health.rs**: `create_dir_all` + `write` in `write_health_file()` called from async `start()` (lines 60, 67)
- **socket.rs**: `remove_file` × 2 in `cleanup_stale_socket()` + shutdown (lines 65, 146)
- **imessage_reader.rs**: `create_dir_all` + `write` in `persist_to_disk()` called from async `start()` (lines 215, 218)
- **credential_pool.rs**: `create_dir_all`, `read_to_string`, `read_dir` in async event handlers (lines 244, 649, 677)
- **icons.rs**: `create_dir_all`, `write`, `metadata`, `remove_dir_all`, `read_dir` × 2 in async icon management (lines 82, 89, 121, 139–149, 182, 194)

## Out of Scope
- `std::fs` in sync initialization/load functions (config.rs, credentials.rs, notes.rs, project_registry.rs)
- `std::fs` in TUI event handlers (acceptable; TUI is not async)
- Test-only `std::fs` usage (lower risk, separate pass)
- Dead code cleanup (separate spec)
