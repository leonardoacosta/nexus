# Proposal: Config watcher, DRY prompt submission, receiver router cleanup

## Change ID
`fix-tui-agent-cleanup`

## Summary
Fix a cosmetic-only config watcher that misleads users, eliminate duplicated prompt submission logic in the TUI, and clean up the receiver's 990-line HTTP router by extracting handler functions and migrating from raw TCP to axum.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/http_router.rs` (990 lines), `crates/nexus-tui/src/main.rs` (config watcher at L473-548, background_task at L550-647), `crates/nexus-tui/src/keys.rs` (L114-137), `crates/nexus-tui/src/ui_helpers.rs` (L85-106)
- Related: `refactor-receiver-service` (extracted http_router.rs from service.rs — this spec further decomposes it and migrates transport), `refactor-tui-god-modules` (extracted keys.rs from main.rs — this spec addresses a duplication introduced during that extraction)

## Motivation
Four independent but thematically related issues degrade maintainability and correctness:

1. **Receiver router bloat (W11):** `handle_request` is ~870 lines — a single match with 15+ arms. Each arm contains full handler logic (deserialization, state mutation, response construction) making the file hard to navigate and test.
2. **Raw TCP parser (W12):** `parse_request` manually reads bytes from a TCP socket with a fixed 8192-byte buffer, no chunked transfer support, and no HTTP/1.1 compliance. The main agent already uses axum — the receiver should too, eliminating `parse_request`, `format_response`, `handle_connection`, and the manual TCP accept loop.
3. **Cosmetic config watcher (W13):** `spawn_config_watcher` detects changes to `agents.toml`, re-parses it, and shows a "config reloaded: N agents" toast — but the reloaded config is never wired into the `NexusClient` inside `background_task`. The polling loop keeps querying the old agent list, making the notification misleading.
4. **Duplicated prompt submission (W14):** Identical 20-line prompt-submission sequences exist in `keys.rs:114-137` (Enter key handler) and `ui_helpers.rs:85-106` (external editor submit). Both clear input, set `stream_executing`, push history, emit user header/prompt/separator lines, reset `assistant_header_emitted`, and send `RpcCommand::SendCommand`.

## Requirements
### Req-1: Extract receiver route handlers from match block
Each match arm in `handle_request` SHALL be extracted into a dedicated async function (e.g., `handle_health`, `handle_speak`, `handle_play`, `handle_mode_get`, `handle_mode_set`, `handle_mode_cycle`, `handle_reload`, `handle_watch_register`, `handle_imessage`, `handle_history`, `handle_messages`, `handle_status_notifications`). `handle_request` SHALL remain as a thin dispatch table that delegates to these functions.

### Req-2: Migrate receiver from raw TCP to axum
`ReceiverService` SHALL use an axum `Router` instead of manual TCP accept + `parse_request` + `format_response` + `handle_connection`. The axum router SHALL bind to the same port and serve the same routes. `parse_request`, `format_response`, and `handle_connection` SHALL be removed.

### Req-3: Wire config watcher to update NexusClient
When `agents.toml` changes, the reloaded configuration SHALL be propagated to the `background_task`'s `NexusClient` so that subsequent polling uses the updated agent list. New agents SHALL be connected; removed agents SHALL be dropped.

### Req-4: Extract duplicated prompt submission to App::submit_prompt
A single `App::submit_prompt(&mut self, prompt: String, rpc_tx: &mpsc::Sender<RpcCommand>)` method SHALL encapsulate: clear input, set `stream_executing` + `stream_exec_start`, push history, push user header + prompt lines + blank separator, reset `assistant_header_emitted`, and send `RpcCommand::SendCommand`. Both `keys.rs` Enter handler and `ui_helpers.rs` editor submit SHALL call this method.

## Scope
- **IN**: Extract handler functions from http_router.rs, migrate receiver to axum, fix config watcher to propagate config into NexusClient, extract App::submit_prompt
- **OUT**: Refactoring other parts of service.rs (covered by `refactor-receiver-service`), further TUI module extraction (covered by `refactor-tui-god-modules`), changing receiver API contract or routes, adding new receiver endpoints

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-agent/src/services/receiver/http_router.rs` | Extract 15+ handler functions, replace raw TCP with axum router |
| `crates/nexus-agent/src/services/receiver/mod.rs` | Update to use axum instead of TcpListener |
| `crates/nexus-agent/Cargo.toml` | axum already a dep (main agent uses it) — may need to add `axum` to receiver module imports |
| `crates/nexus-tui/src/main.rs` | Config watcher sends reloaded config to background_task; background_task accepts config updates via RpcCommand |
| `crates/nexus-tui/src/app.rs` | Add `submit_prompt()` method to App |
| `crates/nexus-tui/src/keys.rs` | Replace inline prompt logic with `app.submit_prompt()` call |
| `crates/nexus-tui/src/ui_helpers.rs` | Replace inline prompt logic with `app.submit_prompt()` call |

## Risks
| Risk | Mitigation |
|------|-----------|
| Axum migration changes receiver behavior | Keep identical routes, methods, status codes; verify with existing tests |
| Config hot-reload races with in-flight requests | Use RpcCommand channel to serialize config updates with other commands |
| submit_prompt signature mismatch between call sites | Both sites have identical logic today — single extraction with same parameters |
