## Summary

Replace hand-drawn Unicode box borders in the detail screen's `render_card()` function with ratatui Block widgets and padding. The detail screen is the only screen using manual Unicode box-drawing characters (┌─┐│└┘).

## Motivation

All other screens use `Block::default().borders(Borders::ALL)` for panel borders. The detail screen uniquely hand-draws borders using `format!()` with Unicode characters (`\u{250C}`, `\u{2500}`, `\u{2510}`, `\u{2502}`, `\u{2514}`, `\u{2518}`). This is the last hand-rolled rendering hack in the TUI.

## Approach

1. Replace `render_card()` (detail.rs lines 199-247) with `Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).title(title)`
2. Render card content inside the Block's inner area
3. Preserve the 2-panel layout (left metadata + right status)

## Files Modified

- `crates/nexus-tui/src/screens/detail.rs` — replace render_card() Unicode borders with Block widget (lines 199-247)
