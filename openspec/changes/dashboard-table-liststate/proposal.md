## Summary

Replace the dashboard's manual Paragraph-based session list with ratatui Table + ListState + Scrollbar widgets for proper column alignment, keyboard-driven selection with scroll tracking, and a visual scroll indicator.

## Motivation

The dashboard renders session rows as manually composed `Line` objects in a single `Paragraph`. This lacks column alignment, proper scroll state, and any visual scroll indicator. The `selected_index: usize` is a bare integer shared across screens with manual clamping. Table + ListState gives proper widget-level selection, scroll, and header support.

## Approach

1. Replace `Paragraph::new(visible_lines)` with `Table::new(rows, widths)` + header row
2. Replace `app.selected_index` usage in dashboard with `TableState` (ratatui 0.30)
3. Add `Scrollbar` widget on right edge, driven by `TableState` position
4. Preserve project grouping headers as non-selectable rows
5. Preserve status colors and session formatting

## Files Modified

- `crates/nexus-tui/src/screens/dashboard.rs` — replace Paragraph rendering (lines 49-179) with Table + Scrollbar
- `crates/nexus-tui/src/app.rs` — add `TableState` field, replace `selected_index` for dashboard
- `crates/nexus-tui/src/main.rs` — update key handlers for dashboard selection to use TableState
