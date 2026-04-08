# Change: TUI reliability — eliminate panics, reconnect, buffer cap, UX gaps

## Why

A platform audit (2026-04-06) found 14 reliability and usability defects in `nexus-tui`: two
P1/P2 panics that crash the process on startup or under connection churn, an alert stream that
gives up permanently after ~2 min, an unbounded in-memory stream buffer, and several P3 UX
gaps (stale data, no resize handling, missing error UI, key-logging, metadata loss, fuzzy
search, multi-select). Together they make the TUI fragile in real networked environments.

## What Changes

- **OTel exporter panic (P1)**: Replace `.expect()` in `main.rs:156` with `match` — fall back
  to non-OTel tracing subscriber instead of crashing when the exporter fails to build.
- **Logging init panic (P2)**: Replace `.unwrap()` on directive parsing in `main.rs:167,174`
  with `.unwrap_or_else(|_| Directive::default())` so invalid `RUST_LOG` syntax does not
  abort startup.
- **Connection race (P2)**: Remove `.unwrap()` after `.is_some()` guard in `client.rs:378,415`;
  use `Option::take()` (or hold the borrow) so the client reference is consumed atomically.
- **Alert stream no-reconnect (P2)**: Replace one-shot loop in `subscribe_alert_stream` with
  infinite reconnect using exponential backoff; expose reconnect state to the UI.
- **Stream lifetime / MAX_RECONNECT_ATTEMPTS (P2)**: Remove the hard cap of 5 attempts in
  `stream.rs:7`; switch to infinite reconnect with exponential backoff and a maximum interval
  cap, plus a manual reconnect action in the TUI.
- **Navigation state corruption (P3)**: Add unit tests for the navigation state machine.
- **Unbounded stream buffer (P3)**: Cap in-memory stream buffer at 10,000 lines; evict oldest
  on overflow.
- **No agent-unreachable UI (P3)**: Show "Agent offline — last seen <timestamp>" in session
  list rows when an agent is unreachable.
- **No data freshness indicator (P3)**: Add a last-update timestamp display in the status bar;
  visually dim stale data after a configurable threshold.
- **Terminal resize not handled (P3)**: Handle `crossterm::event::Event::Resize` to recompute
  layout and redraw immediately.
- **No key logging (P3)**: Add structured `tracing::debug!` calls for every key event
  dispatched, gated behind `RUST_LOG=nexus_tui::keys=debug`.
- **Snapshot metadata dropped (P3)**: Preserve and propagate metadata fields through snapshot
  update path.
- **GCF — Fuzzy search (GCF)**: Add prefix/BM25-style fuzzy search across session names and
  project names within the command palette.
- **GCF — Multi-select (GCF)**: Enable multi-select for bulk session operations (kill,
  attach-queue) using Space to toggle selection.

## Impact

- Affected specs: `tui-client`, `tui-rendering`, `tui-structure`, `tui-input`,
  `observability-stack`
- Affected code:
  - `crates/nexus-tui/src/main.rs` — OTel and logging init
  - `crates/nexus-tui/src/client.rs` — connection race
  - `crates/nexus-tui/src/stream.rs` — reconnect, buffer cap
  - `crates/nexus-tui/src/app.rs` — freshness indicator, resize, snapshot metadata
  - `crates/nexus-tui/src/` (nav, keys) — navigation tests, key logging
