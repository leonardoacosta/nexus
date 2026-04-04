# Proposal: fix(agent): replace blocking reqwest client in sync_telemetry with async

## Change ID
`fix-blocking-reqwest-telemetry`

## Summary
Replace `reqwest::blocking::Client` in `sync_telemetry.rs` with async `reqwest::Client`, eliminating a thread-pool hop and the `blocking` feature dependency.

## Context
- Extends: `crates/nexus-agent/src/services/sync_telemetry.rs`, `crates/nexus-agent/Cargo.toml`
- Related: The rest of nexus-agent already uses async `reqwest::Client` (http_handlers.rs, socket.rs, credential_watcher.rs, tts_elevenlabs.rs)

## Motivation
`send_batch_blocking` at line 128 creates a `reqwest::blocking::Client` inside a `spawn_blocking` wrapper. This is wasteful — it occupies a blocking-thread-pool slot for a network I/O call that the async reqwest client handles natively on the tokio runtime. Replacing it with async reqwest removes the thread-pool pressure and aligns with the rest of the codebase.

## Requirements
### Req-1: Async telemetry batch send
Convert `send_batch_blocking` to an async function using `reqwest::Client`, removing the `spawn_blocking` wrapper in `send_batch`.

### Req-2: Remove blocking feature
Remove the `blocking` feature from `reqwest` in `crates/nexus-agent/Cargo.toml` since no other code in nexus-agent uses it.

## Scope
- **IN**: Convert sync_telemetry HTTP call to async, remove blocking feature from Cargo.toml
- **OUT**: Other crates that use `reqwest::blocking` (e.g. nexus-status) are not touched

## Impact
| Area | Change |
|------|--------|
| `sync_telemetry.rs` | `send_batch_blocking` becomes async `send_batch`, `spawn_blocking` wrapper removed |
| `Cargo.toml` | `blocking` feature removed from reqwest dependency |
| Runtime | One fewer blocking-thread-pool slot consumed per telemetry flush |

## Risks
| Risk | Mitigation |
|------|-----------|
| Behavior change in timeout/retry semantics | Async reqwest uses same timeout API; verify timeout config carries over |
| reqwest::Client construction cost | Reuse client or construct per-call (current pattern); cost is negligible for async client |
