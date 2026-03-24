## Summary

Add a visual Tabs widget for screen navigation, apply consistent padding/rounded borders across all screens, and normalize Paragraph::wrap usage. This transforms the TUI from "keyboard shortcut discovery" to "visible navigation."

## Motivation

Screen switching currently has no visual indicator — users must know Tab/BackTab exists. No tab bar, no current-screen highlight. Padding and border styles are inconsistent across the 5 screens. Some use Block::default().borders(), others have none.

## Approach

1. Add `ratatui::widgets::Tabs` widget rendered at top of every screen
2. Highlight the current screen tab
3. Apply `Block::padding(Padding::horizontal(1))` to all content panels
4. Switch to `BorderType::Rounded` where appropriate
5. Normalize `Paragraph::wrap(Wrap { trim: true })` in all text-heavy panels

## Files Modified

- `crates/nexus-tui/src/main.rs` — add Tabs rendering in the base layout (shared across all screens)
- `crates/nexus-tui/src/screens/dashboard.rs` — padding, rounded borders
- `crates/nexus-tui/src/screens/detail.rs` — padding, rounded borders
- `crates/nexus-tui/src/screens/health.rs` — padding, rounded borders
- `crates/nexus-tui/src/screens/projects.rs` — padding, rounded borders
- `crates/nexus-tui/src/screens/stream.rs` — padding, rounded borders
- `crates/nexus-tui/src/markdown.rs` — Paragraph::wrap consistency
- `crates/nexus-tui/src/screens/palette.rs` — padding, rounded borders
