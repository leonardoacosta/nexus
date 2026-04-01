# Proposal: TUI final cleanup — stale endpoints, dead code, render perf, lint

## Change ID
`fix-tui-final-cleanup`

## Summary
Consolidate 8 remaining TUI audit findings into a single cleanup pass: fix stale alert endpoint subscriptions after config reload, remove dead code, apply cargo fmt/clippy, eliminate per-frame clones in render functions, fix unwrap fragility, and replace two hardcoded values with dynamic data.

## Context
- Extends: `crates/nexus-tui/src/main.rs`, `crates/nexus-tui/src/app.rs`, `crates/nexus-tui/src/keys.rs`, `crates/nexus-tui/src/theme.rs`, `crates/nexus-tui/src/notification.rs`, `crates/nexus-tui/src/client.rs`, `crates/nexus-tui/src/stream_state.rs`, `crates/nexus-tui/src/stream.rs`, `crates/nexus-tui/src/ui_helpers.rs`, `crates/nexus-tui/src/screens/dashboard.rs`, `crates/nexus-tui/src/screens/projects.rs`, `crates/nexus-tui/src/screens/health.rs`, `crates/nexus-tui/src/screens/stream.rs`
- Related: `fix-tui-agent-cleanup` (covers config watcher propagation and prompt DRY — distinct from alert stream resubscription here), `refactor-tui-god-modules` (completed — extracted keys.rs, theme.rs, notification.rs, stream_state.rs from god modules)

## Motivation
The TUI crate accumulated 8 independent quality issues across correctness, dead code, lint hygiene, render performance, safety, and hardcoded values. Each is small individually but collectively they degrade maintainability and leave known bugs (stale alert subscriptions for new agents, potential panics from unwrap). A single consolidated cleanup pass is more efficient than 8 separate specs.

## Requirements

### Req-1: Resubscribe alert streams after config reload
When `RpcCommand::ReloadConfig` fires and `NexusClient::update_config()` adds new agents, alert streams SHALL be resubscribed so newly-added agents receive alert subscriptions without requiring a TUI restart. The `agent_endpoints` captured at `main.rs:108-112` SHALL either be refreshed and used to resubscribe, or the alert stream mechanism SHALL be made dynamic.

### Req-2: Remove dead code
The following dead items SHALL be removed:
- `app.rs:782` — `update_projects()` method (zero call sites)
- `theme.rs:80` — `status_sparkline()` function (never used)
- `notification.rs:113,122` — `selected_rules()` and `selected_has_override()` methods (never called)
- `notification.rs:80` — `is_default` field in `NotificationPanelRow` (never read)
- `client.rs:209-213` — `backoff_duration()` `#[allow(dead_code)]` annotation SHALL be removed; if only used in tests, move to `#[cfg(test)]` module; fix doc comment that says "5+->30s" when the implementation caps at 16s (`1 << 4 = 16`)

### Req-3: Apply cargo fmt
Run `cargo fmt -p nexus-tui` to resolve the 14 formatting hunks across `app.rs`, `keys.rs`, `main.rs`, `ui_helpers.rs`. No manual formatting changes — purely `rustfmt` output.

### Req-4: Fix clippy warnings
Resolve all 6 clippy warnings in nexus-tui:
- Collapsible `if` statements in `app.rs` and `keys.rs` — collapse nested ifs into combined conditions
- Unused import `Clear` in `screens/stream.rs:6` — remove import
- Useless `format!()` in `screens/dashboard.rs:124` — replace with direct string expression
- Items after test module in `screens/health.rs:311` — move items before `#[cfg(test)]` module

### Req-5: Replace .to_vec() clones with slice borrows in render functions
`dashboard.rs:49` clones `cached_sessions` every frame and `projects.rs:45,169` clones `cached_project_summaries` twice per frame. Render functions SHALL borrow slices (`&[T]`) instead of cloning into owned `Vec<T>`. If the render function signatures need `&App` instead of owned data, adjust accordingly.

### Req-6: Fix notification panel unwrap() calls
The 4 `unwrap()` calls on `app.notification_panel.as_mut()` at `keys.rs:573,580,587,594` SHALL be restructured to reuse the existing `panel` binding from the match guard that already proved the panel is `Some`. Eliminate the redundant `as_mut().unwrap()` pattern.

### Req-7: Pass terminal width to markdown renderer
`stream_state.rs:121` hardcodes `push_markdown(&buf, 120)`. The actual terminal width SHALL be passed instead. Either accept width as a parameter to the method that calls `push_markdown`, or read terminal dimensions at the call site.

### Req-8: Source CWD from agent project data
`keys.rs:741` hardcodes `~/dev/{project}` as the default CWD for new sessions. The default SHALL come from agent project data (project path from the agent's project listing) if available, falling back to `~/dev/{project}` only when agent data is absent.

## Scope
- **IN**: All 8 findings listed above, scoped exclusively to `crates/nexus-tui/`
- **OUT**: Receiver refactoring (covered by `fix-tui-agent-cleanup`), further module extraction (covered by `refactor-tui-god-modules`), nexus-core or nexus-agent changes beyond what is needed to support Req-7/Req-8

## Impact
| Area | Change |
|------|--------|
| `main.rs` | Resubscribe alert streams on config reload (Req-1) |
| `app.rs` | Remove `update_projects()`, fix collapsible if, fmt (Req-2, Req-3, Req-4) |
| `theme.rs` | Remove `status_sparkline()` (Req-2) |
| `notification.rs` | Remove `selected_rules()`, `selected_has_override()`, `is_default` field (Req-2) |
| `client.rs` | Fix `backoff_duration()` — move to test or remove, fix doc (Req-2) |
| `keys.rs` | Fix collapsible if, fmt, restructure unwraps, source CWD (Req-3, Req-4, Req-6, Req-8) |
| `screens/dashboard.rs` | Borrow slice instead of clone, fix useless format! (Req-4, Req-5) |
| `screens/projects.rs` | Borrow slices instead of clone (Req-5) |
| `screens/stream.rs` | Remove unused `Clear` import (Req-4) |
| `screens/health.rs` | Move items before test module (Req-4) |
| `stream_state.rs` | Accept terminal width parameter (Req-7) |
| `ui_helpers.rs` | fmt only (Req-3) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Removing `backoff_duration` breaks reconnect logic | Verify all call sites; if only test-used, move to `#[cfg(test)]` rather than deleting |
| Changing render function signatures to borrow slices causes lifetime issues | Keep `&App` borrow pattern — render functions already receive `&App`, just avoid cloning fields |
| Alert stream resubscription could cause duplicate streams | Cancel existing alert stream before resubscribing, or track subscribed endpoints and only add new ones |
| Removing `is_default` field could break deserialization | Field is internal state only (not serialized), safe to remove |
