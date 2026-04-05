## 1. API Batch (Rust — nexus-tui)

- [ ] 1.1 **Client construction fix** (nx-3te5) — In `crates/nexus-tui/src/main.rs`, move `reqwest::Client::builder().build()` out of the `tokio::select!` branch at line 732. Build the client once before the polling loop starts and propagate any error with `?`. Pass the pre-built client into the spec interval branch by reference.
- [ ] 1.2 **Resize handler** (nx-55hx) — In the event loop at `main.rs:564-578`, add an `Event::Resize(cols, rows)` match arm. Call `terminal.resize(Rect { x: 0, y: 0, width: cols, height: rows })?` (or equivalent ratatui API) and trigger an immediate redraw by setting a flag or calling `terminal.draw(...)` inline.
- [ ] 1.3 **Stream auto-reconnect** (nx-agrb) — In `crates/nexus-tui/src/stream.rs`, replace the `return` at line 91 with a retry loop. On stream end or connection failure, wait `min(2^attempt, 30)` seconds and retry, up to `MAX_RECONNECT_ATTEMPTS = 5`. After exhaustion, send a `StreamMessage::Disconnected { reason }` variant so the TUI can display an error banner.
- [ ] 1.4 **Error states surfaced in UI** (nx-b0qx) — In `main.rs:815-819`, replace the silent `Vec::new()` fallback with `RpcResult::ProjectListErr(e.to_string())`. Add a `ProjectListErr` variant to `RpcResult` and handle it in the main event loop to display an error notification. In `stream.rs`, ensure the new `StreamMessage::Disconnected` variant is handled in `main.rs` to show an error banner in the StreamAttach view.
- [ ] 1.5 **Named timing constants** (nx-316t) — In `main.rs`, extract the following magic numbers to named `const` declarations at the top of the file:
  - Line 445: debounce window (5s) → `const STATUS_DEBOUNCE_SECS: u64 = 5;`
  - Line 537: notification dismiss threshold (15 ticks) → `const NOTIFICATION_DISMISS_TICKS: u64 = 15;`
  - Line 549: heartbeat staleness threshold (50 ticks) → `const HEARTBEAT_STALE_TICKS: u64 = 50;`
  - Add a comment on each const explaining the tick rate assumption (approx. 5 ticks/sec at 200ms poll).
- [ ] 1.6 **Channel backpressure** (nx-f0br) — In `stream.rs:53`, change the channel capacity from the fixed value 256 to a named constant `const STREAM_CHANNEL_CAPACITY: usize = 64;` and add a `try_send` path (or bounded send with drop-oldest) to avoid blocking the stream task when the TUI render loop is slow.
- [ ] 1.7 **Cargo tests** — Run `cargo test -p nexus-tui` and `cargo clippy -p nexus-tui -- -D warnings` to verify no regressions. Fix any new warnings introduced by the above changes.
