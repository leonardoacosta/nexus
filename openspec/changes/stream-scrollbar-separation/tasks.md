## 1. Scrollbar
- [ ] 1.1 Add `stream_scrollbar_state: ScrollbarState` to App struct (app.rs)
- [ ] 1.2 Track total rendered line count in stream view before viewport slicing
- [ ] 1.3 Update ScrollbarState position on scroll (stream.rs key handlers)
- [ ] 1.4 Render `Scrollbar::new(ScrollbarOrientation::VerticalRight)` alongside the message area
- [ ] 1.5 Style scrollbar: track=TEXT_DIM, thumb=TEXT

## 2. Message Separators
- [ ] 2.1 Detect role transitions in the stream message list (user→assistant, assistant→tool, etc.)
- [ ] 2.2 Insert a thin horizontal separator line between message groups (e.g., `"─".repeat(width)` in TEXT_DIM)
- [ ] 2.3 Ensure separators don't break scroll position tracking

## 3. Overlay Clear Fix
- [ ] 3.1 Add `Clear` widget rendering in palette.rs before the command palette overlay (same pattern as projects.rs scratchpad)
- [ ] 3.2 Add `Clear` widget before the start-session overlay in palette.rs

## 4. Heartbeat Suppression
- [ ] 4.1 In stream.rs message filtering, suppress heartbeat-type events when `StreamVerbosity::Normal` is active
- [ ] 4.2 Ensure heartbeats still show in `StreamVerbosity::Verbose` mode

## 5. Validation
- [ ] 5.1 `cargo build` passes
- [ ] 5.2 `cargo test` — all tests pass
- [ ] 5.3 Manual smoke: scroll through stream, verify scrollbar tracks position, separators visible between message groups
