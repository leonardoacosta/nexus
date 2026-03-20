## 1. Dependencies

- [x] 1.1 Add `tonic` to nexus-agent `Cargo.toml` dependencies
- [x] 1.2 Verify proto-and-codegen (spec 1) types are importable from `nexus-core`

## 2. Session Registry

- [x] 2.1 Implement `SessionRegistry` struct in `registry.rs` with `RwLock<HashMap<String, Session>>`
- [x] 2.2 Add `upsert_sessions(&self, sessions: Vec<Session>)` — bulk replace from file watcher
- [x] 2.3 Add `get_all(&self) -> Vec<Session>` — return all tracked sessions
- [x] 2.4 Add `get_by_id(&self, id: &str) -> Option<Session>` — single session lookup
- [x] 2.5 Add `remove_stale(&self, max_age: Duration)` — prune sessions past heartbeat threshold

## 3. File Watcher

- [x] 3.1 Implement `SessionWatcher` in `watcher.rs` using `notify` crate
- [x] 3.2 Watch `~/.claude/projects/*/sessions.json` path pattern for changes
- [x] 3.3 On file change: parse sessions.json, mark all as `SessionType::AdHoc`, upsert into registry
- [x] 3.4 Handle file not found / parse errors gracefully (log warning, don't crash)
- [x] 3.5 Debounce rapid file change events (100ms window)

## 4. gRPC Service

- [x] 4.1 Create `grpc.rs` with `NexusAgentService` struct implementing the tonic-generated `NexusAgent` trait
- [x] 4.2 Implement `get_sessions` RPC — reads from registry, converts to proto `Session` messages
- [x] 4.3 Implement `get_session` RPC — single session lookup by ID, return `NOT_FOUND` if missing
- [x] 4.4 Wire conversion between `nexus_core::session::Session` (serde) and proto `Session` message

## 5. Main Entrypoint

- [x] 5.1 Replace `mod routes` with `mod grpc` in `main.rs`
- [x] 5.2 Initialize `SessionRegistry` (wrapped in `Arc`)
- [x] 5.3 Start `SessionWatcher` as background tokio task
- [x] 5.4 Start tonic gRPC server on `0.0.0.0:7400`
- [x] 5.5 Wire graceful shutdown with `tokio::signal::ctrl_c()`

## 6. Verification

- [x] 6.1 `cargo build -p nexus-agent` compiles without errors
- [x] 6.2 `cargo clippy -p nexus-agent` passes with no warnings
