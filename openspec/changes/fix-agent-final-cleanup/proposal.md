# Proposal: fix(agent): final cleanup — dead code, async hygiene, lint

## Change ID
`fix-agent-final-cleanup`

## Summary
Consolidated cleanup of 7 remaining agent findings: gate macOS-only iMessage module, fix blocking I/O in sync_telemetry flush, remove duplicate socket cleanup, fix cron.rs home_dir call, delete dead `remove_stale`, fix 76 clippy lints, and bundle too-many-arguments wireup functions into context structs.

## Context
- Extends: `crates/nexus-agent/src/services/mod.rs`, `crates/nexus-agent/src/services/imessage_reader.rs`, `crates/nexus-agent/src/services/sync_telemetry.rs`, `crates/nexus-agent/src/socket.rs`, `crates/nexus-agent/src/main.rs`, `crates/nexus-agent/src/cron.rs`, `crates/nexus-agent/src/registry.rs`, `crates/nexus-agent/src/grpc/mod.rs`, `crates/nexus-agent/Cargo.toml`
- Related: `fix-async-hygiene-dead-code-r2` (covers blocking I/O in http_router/grpc/config/failures and shared reqwest client; this spec covers the remaining sync_telemetry flush path), `cleanup-core-post-remediation` (covers home_dir migration in nexus-core; this spec fixes the nexus-agent cron.rs call site missed in that sweep)

## Motivation
Post-audit sweep found 7 findings that collectively add dead code, risk tokio runtime stalls, duplicate logic, and trigger 76 clippy warnings. Each is individually small but cleaning them in one pass avoids 7 separate spec/PR cycles and leaves the agent crate in a lint-clean state.

## Requirements

### Req-1: Gate IMessageReaderService with cfg(macos)
The `imessage_reader` module is macOS-only (reads `~/Library/Messages/chat.db` via rusqlite) but compiles on all platforms, pulling rusqlite as a hard dependency and exposing 6 unused functions on Linux. The `pub mod imessage_reader;` declaration in `services/mod.rs` SHALL be gated with `#[cfg(target_os = "macos")]`. The `rusqlite` dependency in `Cargo.toml` SHALL be made optional behind a `macos` feature flag. Any `use` of `imessage_reader` types elsewhere SHALL be similarly gated.

### Req-2: Fix sync_telemetry::flush() blocking filesystem I/O
`SyncTelemetryService::flush()` and its helpers `read_queue()`, `requeue_events()` use blocking `std::fs::read_to_string`, `std::fs::write`, `std::fs::remove_file`, `File::open`, and `BufReader` in an async context (called from the async `start()` loop). These SHALL be migrated to `tokio::fs` equivalents or wrapped in `tokio::task::spawn_blocking` to avoid stalling the tokio runtime during queue I/O.

### Req-3: Remove duplicate cleanup_stale_socket() call
`cleanup_stale_socket()` is called at `main.rs:105` before spawning the socket service, and again at `socket.rs:100` inside `run_socket_service`. The call in `socket.rs:100` SHALL be removed since the caller in `main.rs` already performs the cleanup before the socket is bound.

### Req-4: Fix cron.rs raw std::env::var("HOME")
`cron.rs:359` uses `std::env::var("HOME").ok().map(PathBuf::from)` instead of `nexus_core::paths::home_dir()`. This is an incomplete migration from wave 6 (`cleanup-core-post-remediation` Req-5). This call site SHALL be updated to use `nexus_core::paths::home_dir()`.

### Req-5: Delete dead remove_stale() in registry.rs
`registry.rs:93` defines `remove_stale()` behind `#[allow(dead_code)]` with a comment "Used by future health/ops spec". This function has been superseded by `detect_stale()` (registry.rs:275) which handles stale detection with proper status transitions and event emission. The dead `remove_stale()` method and its `#[allow(dead_code)]` annotation SHALL be deleted.

### Req-6: Fix 76 clippy lint notes
The nexus-agent crate produces 76 clippy warnings across multiple categories: 41x `collapsible_if`, 6x `manual_strip`, 3x `derivable_impls`, 3x `trim_before_split`, 2x `tabs_in_doc_comments`, 2x `if_same_then_else`, 2x `map_or_simplification`, 2x `doc_list_item_without_indentation`, 1x `or_insert_with_default`, 1x `manual_char_comparison`, and misc others. Auto-fixable lints SHALL be resolved via `cargo clippy --fix -p nexus-agent`. Remaining non-auto-fixable lints SHALL be manually corrected. The target is zero clippy warnings for the agent crate.

### Req-7: Bundle too-many-arguments wireup functions into context structs
Three functions exceed clippy's 7-argument threshold: `run_socket_service` (8 params), `handle_connection` (8 params), and `NexusAgentService::new` (10 params). Each SHALL have its parameters bundled into a dedicated context/config struct to reduce argument count and improve readability. For socket functions, a `SocketContext` struct. For `NexusAgentService`, an `AgentServiceConfig` struct.

## Scope
- **IN**: All 7 findings above, scoped to nexus-agent crate (with one nexus-core clippy fix in lifecycle.rs)
- **OUT**: nexus-tui changes, nexus-core changes beyond the 1 clippy lint in lifecycle.rs, any behavioral changes to API responses, any changes already covered by `fix-async-hygiene-dead-code-r2` or `cleanup-core-post-remediation`

## Impact
| Area | Change |
|------|--------|
| `services/mod.rs` | Gate `imessage_reader` with `#[cfg(target_os = "macos")]` |
| `services/imessage_reader.rs` | No changes to file itself, just gated at module level |
| `Cargo.toml` | Make `rusqlite` optional behind `macos` feature flag |
| `services/sync_telemetry.rs` | Migrate `read_queue`, `requeue_events`, flush recovery to async I/O |
| `socket.rs` | Remove duplicate `cleanup_stale_socket` call at line 100; extract `SocketContext` struct for `run_socket_service` and `handle_connection` params |
| `main.rs` | Update `run_socket_service` call to pass `SocketContext`; update `NexusAgentService::new` call |
| `cron.rs` | Replace `std::env::var("HOME")` at line 359 with `nexus_core::paths::home_dir()` |
| `registry.rs` | Delete `remove_stale()` method and `#[allow(dead_code)]` |
| `grpc/mod.rs` | Extract `AgentServiceConfig` struct for `NexusAgentService::new` params |
| 15+ files | Fix clippy lints (collapsible_if, manual_strip, derivable_impls, etc.) |

## Risks
| Risk | Mitigation |
|------|-----------|
| `cfg(macos)` gate breaks macOS compilation if imessage_reader types are used unconditionally elsewhere | Grep all `use` of imessage_reader types and gate them; verify with `--target x86_64-apple-darwin` if cross-compilation is available |
| Making sync_telemetry I/O async changes error propagation behavior | Maintain identical error semantics (requeue on failure, skip malformed lines); existing tests cover these paths |
| Removing duplicate socket cleanup creates a race if main.rs call order changes | The cleanup is deterministic (check PID, remove stale file); even if called twice it's idempotent, so removing the redundant call is safe |
| `cargo clippy --fix` may produce unexpected changes | Review diff after auto-fix; run `cargo test` to verify no regressions |
| Context struct refactor changes public API of `run_socket_service` and `NexusAgentService::new` | Both are crate-internal (not pub(crate) exported to other crates); all call sites are in main.rs |
