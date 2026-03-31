# Change: Split TUI main.rs and app.rs god modules into focused sub-modules

## Why
`crates/nexus-tui/src/main.rs` (1,691 lines) and `crates/nexus-tui/src/app.rs` (2,120 lines) total 3,811 lines across two files that each contain multiple unrelated responsibilities. `main.rs` mixes the event loop with all key handlers for every mode, background tasks, config watcher, editor launcher, mouse handler, and tab rendering. `app.rs` has ~25 type definitions, App struct (30+ fields), StreamViewState (30+ fields), NotificationManager, color constants, format utilities, and markdown buffer management.

## What Changes
- Extract per-mode key handlers from `main.rs` into `keys.rs` (or `keys/` directory with per-mode modules)
- Extract `StreamViewState` and its methods from `app.rs` into `stream_state.rs`
- Extract `NotificationManager` and notification types from `app.rs` into `notification.rs`
- Extract color/format utility functions (`format_duration`, `format_age`, `status_dot`, `status_color`, etc.) from `app.rs` into `theme.rs`
- Keep `main.rs` as event loop + startup and `app.rs` as App struct + core state

## Impact
- Affected specs: none (pure structural refactor, no behavior change)
- Affected code: `crates/nexus-tui/src/main.rs` (1,691 lines), `crates/nexus-tui/src/app.rs` (2,120 lines) decomposed into 4-5 new modules
- The TUI crate already has `screens/`, `stream.rs`, `markdown.rs` — this continues the existing decomposition pattern
