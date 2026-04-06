## 1. Panic Elimination

- [ ] 1.1 Replace `.expect("failed to build OTel span exporter")` in `main.rs:156` with a `match`
      block that logs a warning and falls back to the non-OTel subscriber branch
- [ ] 1.2 Replace `.unwrap()` on `"nexus_tui=info".parse()` in `main.rs:167` with
      `.unwrap_or_else(|_| Directive::default())`
- [ ] 1.3 Replace the duplicate `.unwrap()` in the non-OTel branch in `main.rs:174` with the
      same `.unwrap_or_else(|_| Directive::default())` pattern
- [ ] 1.4 Replace `agent.client.as_mut().unwrap()` in `client.rs:378` with `Option::take()` so
      the borrow is consumed atomically after the `.is_some()` guard
- [ ] 1.5 Apply the same `Option::take()` fix to `client.rs:415`

## 2. Reconnect — Alert Stream

- [ ] 2.1 Refactor `subscribe_alert_stream` to spawn a per-agent reconnect loop (infinite,
      exponential backoff starting at 1 s, capped at 60 s) instead of a one-shot connect
- [ ] 2.2 Add `AlertStreamStatus` enum (`Connected`, `Reconnecting { attempt: u32, next_try_secs: u64 }`,
      `Failed`) and thread it through `AppState` so the UI can read it
- [ ] 2.3 Render reconnect status in the status bar when any alert stream is reconnecting

## 3. Reconnect — Session Stream

- [ ] 3.1 Remove `MAX_RECONNECT_ATTEMPTS` constant from `stream.rs`
- [ ] 3.2 Replace the bounded retry loop with an infinite exponential-backoff loop (1 s base,
      2× multiplier, 120 s cap)
- [ ] 3.3 Expose current reconnect state (`Connecting`, `Streaming`, `Reconnecting { attempt }`,
      `Stopped`) via a watch channel read by the stream view
- [ ] 3.4 Add a manual reconnect key binding (`r`) in stream view that resets backoff and
      triggers an immediate reconnect attempt

## 4. Stream Buffer Cap

- [ ] 4.1 Add `const STREAM_BUFFER_MAX: usize = 10_000` in `stream.rs`
- [ ] 4.2 In the `StreamViewState` line-push path, evict the oldest entry when the buffer
      exceeds the cap (use `VecDeque` if the current structure is `Vec`)

## 5. Agent Offline UI

- [ ] 5.1 In the session list renderer, detect `ConnectionStatus::Disconnected` /
      `ConnectionStatus::Failed` for each agent and inject a synthetic row showing
      "Agent offline — last seen <timestamp>" styled with dim foreground
- [ ] 5.2 Wire `agent.last_seen` into the row to format the timestamp

## 6. Data Freshness Indicator

- [ ] 6.1 Track `last_data_updated: Option<Instant>` in `AppState`
- [ ] 6.2 In the status bar renderer, display "Updated Xs ago" and switch to a yellow/dim
      style when staleness exceeds 30 s

## 7. Terminal Resize

- [ ] 7.1 Match `crossterm::event::Event::Resize(cols, rows)` in the event loop and call
      `terminal.resize(Rect { width: cols, height: rows, .. })` followed by a forced redraw

## 8. Key Logging

- [ ] 8.1 Add `tracing::debug!(target: "nexus_tui::keys", ?key, ?mode, "key dispatched")`
      at the top of each per-mode key handler
- [ ] 8.2 Document the `RUST_LOG=nexus_tui::keys=debug` filter in the README / help overlay

## 9. Snapshot Metadata

- [ ] 9.1 Audit the snapshot update path in `app.rs`; identify where metadata fields
      (`session_type`, `status`, etc.) are dropped
- [ ] 9.2 Preserve all metadata fields through the update; add a regression test that
      verifies metadata survives a snapshot refresh cycle

## 10. Navigation State Tests

- [ ] 10.1 Write unit tests for navigation transitions: Dashboard → Detail, Detail → Dashboard,
       Dashboard → Palette → previous screen, StreamAttach ↔ Dashboard
- [ ] 10.2 Write tests for boundary conditions: navigate past end of list, navigate on empty list

## 11. Fuzzy Search

- [ ] 11.1 Implement `fuzzy_match(query: &str, candidate: &str) -> bool` using a prefix-contains
       filter (case-insensitive) as a first pass; score by match position for ranking
- [ ] 11.2 Replace the palette's current exact-contains filter with `fuzzy_match`
- [ ] 11.3 Highlight matched characters in the palette result rows

## 12. Multi-Select

- [ ] 12.1 Add `selected_sessions: HashSet<SessionId>` to `AppState`
- [ ] 12.2 Bind `Space` in the session list to toggle selection of the focused row; render a
       checkbox indicator in the first column
- [ ] 12.3 Add a bulk-kill action (`d` with confirmation) that operates on `selected_sessions`
       when non-empty, falling back to the focused session when the set is empty

## 13. Tests and Quality Gates

- [ ] 13.1 Run `cargo test -p nexus-tui` — all tests pass
- [ ] 13.2 Run `cargo clippy -p nexus-tui -- -D warnings` — no new warnings
- [ ] 13.3 Run `cargo fmt --check -p nexus-tui` — no formatting issues
