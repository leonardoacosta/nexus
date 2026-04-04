# Proposal: fix(agent): async hygiene + dead code cleanup round 2

## Change ID
`fix-async-hygiene-dead-code-r2`

## Summary
Consolidated cleanup of 6 findings in nexus-agent: delete dead code, replace blocking I/O in async paths, share a single reqwest::Client, remove self-HTTP loopback, and fix serde unwraps.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/socket.rs`, `crates/nexus-agent/src/services/receiver/service.rs`, `crates/nexus-agent/src/services/receiver/http_router.rs`, `crates/nexus-agent/src/http_handlers.rs`, `crates/nexus-agent/src/grpc/status.rs`, `crates/nexus-agent/src/config.rs`, `crates/nexus-agent/src/failures.rs`, `crates/nexus-agent/src/socket.rs`, `crates/nexus-agent/src/services/sync_telemetry.rs`, `crates/nexus-agent/src/services/credential_watcher.rs`
- Related: `fix-blocking-reqwest-telemetry` (complementary — converts blocking to async in sync_telemetry; this spec shares the client), `refactor-receiver-service` (completed extraction; this spec removes leftovers)

## Motivation
Post-refactor audit of nexus-agent found dead code, blocking filesystem I/O in async handler paths, per-request HTTP client construction overhead, a self-HTTP loopback that bypasses the in-process API, and unwrap calls on fallible serde serialization. Each finding is small individually but collectively they degrade runtime efficiency and code clarity.

## Requirements

### Req-1: Remove dead receiver/socket.rs module (W7)
`services/receiver/socket.rs` defines `handle_socket_message` and `run_socket_listener` which are never called — the crate-root `socket.rs` handles all Unix socket dispatch. The dead module and its `mod socket;` declaration in `services/receiver/mod.rs` SHALL be deleted.

### Req-2: Remove dead ReceiverService struct fields (W8)
`shared_config` and `reload_rx` fields on the `ReceiverService` struct (`services/receiver/service.rs:36-37`) are stored on construction but never read via `self.`. The identical `shared_config` on `ReceiverState` (which IS used) is unaffected. These dead struct fields and their constructor wiring SHALL be removed.

### Req-3: Replace blocking std::fs with tokio::fs in async paths (W9)
Five async code paths use blocking `std::fs` calls that can stall the tokio runtime:
- `services/receiver/http_router.rs:665` — `std::fs::read_to_string` in GET /mode handler
- `services/receiver/http_router.rs:829` — `std::fs::read_to_string` in GET /messages handler
- `grpc/status.rs:141` — `std::fs::read_dir` in gRPC ListProjects handler
- `config.rs:306` — `std::fs::read_to_string` in `NotificationsConfig::load()`
- `failures.rs:259,276` — `std::fs::read_dir` and `std::fs::read_to_string` in `bootstrap_from_jsonl`

The hot-path handlers (http_router, grpc) SHALL use `tokio::fs`. The startup path (`failures.rs`) MAY use `tokio::spawn_blocking` since it runs once at boot and holds a write lock.

### Req-4: Share single reqwest::Client across call sites (W10)
Four call sites construct a new `reqwest::Client` per request:
- `http_handlers.rs:466` — `check_failure_spike`
- `socket.rs:587` — `relay_notification_to_peers`
- `services/sync_telemetry.rs:129` — `send_batch`
- `services/credential_watcher.rs:142` — credential push

A single shared `reqwest::Client` SHALL be created at startup and passed via `AppState` or service constructors to all call sites.

### Req-5: Remove self-HTTP loopback in check_failure_spike (W5)
`http_handlers.rs:465-499` constructs an HTTP client to GET `http://127.0.0.1:{port}/failures?days=1` from itself. Since `AppState` already contains `failure_buffer: FailureBuffer`, this SHALL call `state.failure_buffer.query_http(1)` directly, eliminating the network round-trip and the dedicated client construction.

### Req-6: Replace serde_json unwraps with proper error handling (W6)
`http_handlers.rs:569,586,603,620` use `.unwrap()` on `serde_json::to_value()` calls. These SHALL be replaced with `.map_err()` returning an appropriate HTTP error status.

## Scope
- **IN**: Dead code deletion, async I/O replacement, shared HTTP client, loopback removal, unwrap fixes — all within nexus-agent crate
- **OUT**: nexus-tui, nexus-core changes; receiver/state.rs shared_config (that one IS used); any behavioral changes to API responses

## Impact
| Area | Change |
|------|--------|
| `services/receiver/socket.rs` | Deleted entirely |
| `services/receiver/mod.rs` | Remove `mod socket;` line |
| `services/receiver/service.rs` | Remove `shared_config` and `reload_rx` fields + constructor wiring |
| `services/receiver/http_router.rs` | Replace 2x `std::fs` with `tokio::fs` |
| `grpc/status.rs` | Replace `std::fs::read_dir` with `tokio::fs::read_dir` |
| `config.rs` | Replace `std::fs::read_to_string` with `tokio::fs::read_to_string` (make `load()` async) |
| `failures.rs` | Replace `std::fs` with `tokio::fs` or `spawn_blocking` |
| `http_handlers.rs` | Remove self-loopback, fix unwraps, accept shared client |
| `socket.rs` | Accept shared `reqwest::Client` instead of constructing per-call |
| `services/sync_telemetry.rs` | Accept shared `reqwest::Client` instead of constructing per-call |
| `services/credential_watcher.rs` | Accept shared `reqwest::Client` instead of constructing per-call |
| `main.rs` | Construct shared `reqwest::Client` at startup, pass to AppState/services |

## Risks
| Risk | Mitigation |
|------|-----------|
| Making `NotificationsConfig::load()` async cascades to callers | Audit all call sites; most are already in async context. Non-async callers can use `tokio::runtime::Handle::current().block_on()` or load config before runtime starts |
| Shared reqwest::Client timeout differs from per-site timeouts | Use `client.get(...).timeout(dur)` per-request overrides where sites need different timeouts, or configure the shared client with the longest timeout |
| Removing receiver/socket.rs breaks something | Confirmed via grep: `handle_socket_message` and `run_socket_listener` have zero call sites outside the file itself |
