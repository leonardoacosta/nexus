## 1. Panic Elimination

- [x] 1.1 Replace `.expect("failed to build OTel span exporter")` in `main.rs:156` with a `match`
      block that logs a warning and falls back to the non-OTel subscriber branch
- [x] 1.2 Replace `.unwrap()` on `"nexus_tui=info".parse()` in `main.rs:167` with
      `.unwrap_or_else(|_| Directive::default())`
- [x] 1.3 Replace the duplicate `.unwrap()` in the non-OTel branch in `main.rs:174` with the
      same `.unwrap_or_else(|_| Directive::default())` pattern
- [x] 1.4 Replace `agent.client.as_mut().unwrap()` in `client.rs:378` with `Option::as_mut()`
      returning an error instead of panicking
- [x] 1.5 Apply the same `Option::as_mut()` fix to `client.rs:415`

## 2. Reconnect — Alert Stream

- [x] 2.1 Refactor `subscribe_alert_stream` to spawn a per-agent reconnect loop (infinite,
      exponential backoff starting at 1 s, capped at 60 s) instead of a one-shot connect
- [x] 2.2 Add `AlertStreamStatus` enum (`Connected`, `Reconnecting { attempt: u32, next_try_secs: u64 }`,
      `Stopped`) and thread it through `AlertMessage` so the event loop can read it
- [x] 2.3 Log reconnect status in the event loop when any alert stream is reconnecting

## 3. Reconnect — Session Stream

- [x] 3.1 Remove `MAX_RECONNECT_ATTEMPTS` constant from `stream.rs`
- [x] 3.2 Replace the bounded retry loop with an infinite exponential-backoff loop (1 s base,
      2× multiplier, 120 s cap)
- [x] 3.3 Expose current reconnect state (`ReconnectState { attempt, next_try_secs }`,
      `ReconnectSucceeded`) via `StreamMessage` variants; stored in `StreamViewState.reconnect_state`
- [x] 3.4 Add a manual reconnect key binding (`r`) in stream view that drops the current
      stream_rx and triggers an immediate reconnect attempt

## 4. Stream Buffer Cap

- [x] 4.1 Add `const STREAM_BUFFER_MAX: usize = 10_000` in `stream_state.rs`
- [x] 4.2 Changed `StreamViewState.lines` from `Vec` to `VecDeque`; evict the oldest entry
      when the buffer exceeds the cap; `lines_evicted` flag set on first eviction

## 5. Agent Offline UI

- [x] 5.1 Added `AgentOfflineRow` struct and `offline_agents()` method to `App`; dashboard
      renderer injects synthetic dim rows for disconnected agents with no sessions
- [x] 5.2 Wire `agent.last_seen` into the offline row to format "last seen Xs ago"

## 6. Data Freshness Indicator

- [x] 6.1 Track `last_data_updated: Option<Instant>` in `App`; set on every successful
      poll that has at least one connected agent
- [x] 6.2 Status bar renderer displays "updated Xs ago" with yellow/dim style when staleness > 30 s

## 7. Terminal Resize

- [x] 7.1 `Event::Resize` already handled in `main.rs` event loop — verified present

## 8. Key Logging

- [x] 8.1 Add `tracing::debug!(target: "nexus_tui::keys", ?key, ?mode, screen, "key dispatched")`
      at the top of `handle_key` dispatch in `keys.rs`
- [x] 8.2 (Deferred — README update out of scope for this wave)

## 9. Snapshot Metadata

- [x] 9.1 Audited snapshot update path in `main.rs`; identified `status: _` field being dropped
- [x] 9.2 Added `session_status: Option<String>` to `StreamViewState`; status field now
      preserved through the `SessionMeta` message handler

## 10. Navigation State Tests

- [x] 10.1 Added tests for: Dashboard→Detail, Detail→Dashboard via `close_detail`,
       Dashboard→Palette→previous screen, StreamAttach↔Dashboard
- [x] 10.2 Added boundary condition tests: move_down on empty list, move_up at zero,
       move_down does not exceed session count, Tab cycling wraps at boundaries

## 11. Fuzzy Search

- [x] 11.1 Implemented `fuzzy_match_score(query, candidate) -> Option<usize>` using
       substring-first then subsequence fallback with position-based scoring
- [x] 11.2 Replaced palette's `contains` filter with `fuzzy_match_score`; results ranked
       by match position
- [x] 11.3 Added `highlight_match` helper in `palette.rs`; matched characters highlighted
       with yellow background in palette result rows

## 12. Multi-Select

- [x] 12.1 Added `selected_sessions: HashSet<String>` to `App`; cleared on screen transitions
- [x] 12.2 Bound `Space` in dashboard session list to toggle selection; checkbox indicator
       (☑/space) rendered in first column
- [x] 12.3 Added `x` key for bulk-kill: stops all selected sessions when set is non-empty,
       falls back to focused session when set is empty

## 13. Tests and Quality Gates

- [x] 13.1 `cargo test -p nexus-tui` — 66 tests pass
- [x] 13.2 `cargo clippy -p nexus-tui -- -D warnings` — no warnings
- [x] 13.3 `cargo fmt --check -p nexus-tui` — no formatting issues
