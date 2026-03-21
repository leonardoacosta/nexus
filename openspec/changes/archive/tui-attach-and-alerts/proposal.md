# Change: Implement stream attach, full attach, and alert notifications in TUI

## Why

The TUI can list and inspect sessions, but cannot interact with them. Users need two modes of
session attachment: stream attach ('a') for tailing session events in real-time from any session,
and full attach ('A') for dropping into a live tmux terminal for managed sessions. Additionally,
there is no notification mechanism for session state changes — stale/errored sessions go unnoticed
until the user manually refreshes the dashboard.

## What Changes

- **Create** `crates/nexus-tui/src/stream.rs` (~100 LOC) — stream attach view: subscribe to gRPC
  `StreamEvents` filtered by session_id, render incoming `SessionEvent` deltas as a scrollable log,
  handle backpressure with bounded channel buffer
- **Create** `crates/nexus-tui/src/attach.rs` (~60 LOC) — full attach: disable crossterm raw mode,
  spawn `ssh user@host -t 'tmux a -t {tmux_session}'` as child process, re-enable raw mode on exit;
  reject ad-hoc sessions with status bar message
- **Create** `crates/nexus-tui/src/notifications.rs` (~40 LOC) — alert notification system:
  subscribe to unfiltered `StreamEvents`, detect `StatusChanged` transitions to Stale/Errored,
  manage notification queue with 10s auto-dismiss
- **Modify** `crates/nexus-tui/src/app.rs` — wire 'a' and 'A' key handlers from dashboard/detail
  screens, add notification rendering in status bar, add `StreamView` and `Attaching` screen states

## Impact

- Affected specs: tui-attach (NEW capability)
- Affected code: `crates/nexus-tui/src/{stream.rs, attach.rs, notifications.rs, app.rs}`
- No breaking changes — additive only
- Phase 5, Wave 5 — estimated ~250 LOC
- Depends on: spec 7 (stream-events-rpc — needs `StreamEvents` gRPC server-streaming), spec 8
  (detail-palette-start — needs screen navigation and detail view for 'a'/'A' context)
- Depended on by: nothing (final spec in the implementation plan)
