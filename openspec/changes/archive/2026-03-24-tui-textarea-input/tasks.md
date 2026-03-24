## 1. Dependency Setup
- [ ] 1.1 Add `tui-textarea` to workspace Cargo.toml (ensure compatibility with ratatui 0.30)
- [ ] 1.2 Add `tui-textarea = { workspace = true }` to nexus-tui/Cargo.toml

## 2. State Migration
- [ ] 2.1 Replace `stream_input: String` in App struct with `stream_textarea: TextArea<'static>` (app.rs)
- [ ] 2.2 Replace `scratchpad_text: String` in App struct with `scratchpad_textarea: TextArea<'static>` (app.rs)
- [ ] 2.3 Handle borrow issue: render functions take `&App` but TextArea widget rendering needs ownership or `&mut` — use `RefCell<TextArea>` or extract TextArea rendering to a method on App
- [ ] 2.4 Initialize TextAreas in App::new() with appropriate placeholder text
- [ ] 2.5 Update all reads of `stream_input` (e.g., sending command) to use `textarea.lines().join("\n")`

## 3. Stream Input Bar
- [ ] 3.1 Replace hand-rolled input rendering (stream.rs lines 498-579) with `TextArea::widget()` rendering
- [ ] 3.2 Preserve the executing-spinner branch (lines 503-520) — show spinner when command is running, TextArea when idle
- [ ] 3.3 Style TextArea with appropriate border and cursor color
- [ ] 3.4 Preserve the " > " prompt prefix (configure via TextArea line number or block title)

## 4. Scratchpad Editor
- [ ] 4.1 Replace scratchpad rendering in projects.rs with `TextArea::widget()` in the overlay
- [ ] 4.2 Preserve the overlay positioning (already using Rect::centered from Wave 1)

## 5. Key Event Routing
- [ ] 5.1 In main.rs, route key events to `stream_textarea.input(event)` when `InputMode::StreamInput`
- [ ] 5.2 Route key events to `scratchpad_textarea.input(event)` when `InputMode::ScratchpadEdit`
- [ ] 5.3 Preserve Enter-to-send behavior (intercept Enter before passing to TextArea, unless Shift+Enter for newline)
- [ ] 5.4 Preserve Ctrl+E for external editor flow
- [ ] 5.5 Preserve Up/Down for history navigation when input is single-line

## 6. Validation
- [ ] 6.1 `cargo build` passes
- [ ] 6.2 `cargo test` — all tests pass
- [ ] 6.3 Manual smoke: type in stream input, verify cursor moves, selection works, copy/paste works, undo works
- [ ] 6.4 Manual smoke: open scratchpad, verify TextArea editing works in overlay
