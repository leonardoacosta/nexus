## Summary

Replace the hand-rolled input bar in stream.rs and the scratchpad editor in projects.rs with the `tui-textarea` widget, gaining cursor positioning, text selection, copy/paste, and undo for free.

## Motivation

Stream input and scratchpad are both rendered as raw strings with a Unicode block cursor (`\u{2588}`). No selection, no copy/paste, no undo. The `tui-textarea` crate provides a proper text editor widget that integrates with ratatui's rendering pipeline.

## Approach

1. Add `tui-textarea` dependency
2. Replace `app.stream_input: String` with `TextArea` instance
3. Replace `app.scratchpad_text: String` with `TextArea` instance
4. Route key events through `TextArea::input()` when in input mode
5. Preserve the executing-spinner branch in stream input (show spinner instead of textarea when command is running)
6. Handle borrow plumbing: render functions take `&App` but TextArea needs `&mut` for cursor state — may need `RefCell` or split rendering

## Files Modified

- `crates/nexus-tui/Cargo.toml` — add tui-textarea dependency
- `Cargo.toml` — add tui-textarea to workspace deps
- `crates/nexus-tui/src/app.rs` — replace String fields with TextArea, adjust borrow patterns
- `crates/nexus-tui/src/screens/stream.rs` — replace render_input_bar (lines 498-579) with TextArea widget
- `crates/nexus-tui/src/screens/projects.rs` — replace scratchpad rendering with TextArea widget
- `crates/nexus-tui/src/main.rs` — route key events to TextArea::input() in appropriate modes
