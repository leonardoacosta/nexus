## Summary

Add a Scrollbar to the stream view with position tracking, improve visual separation between message groups, fix missing Clear widget on palette/start-session overlays, and suppress heartbeat events in Normal verbosity mode.

## Motivation

The stream view has no scroll position indicator — users can't tell where they are in a long conversation. Message groups (user/assistant/tool) blend together without clear visual breaks. Overlays sometimes leave rendering artifacts because Clear widget is not used.

## Approach

1. Add `ScrollbarState` tracking total line count and current scroll position
2. Render `Scrollbar` on right edge of stream message area
3. Add horizontal rule or blank line separator between message role transitions
4. Add `Clear` widget rendering before palette and start-session overlays
5. Suppress heartbeat events when StreamVerbosity is Normal (one-line filter addition)

## Files Modified

- `crates/nexus-tui/src/screens/stream.rs` — Scrollbar + ScrollbarState, message separators, heartbeat filter
- `crates/nexus-tui/src/app.rs` — add ScrollbarState field for stream view
- `crates/nexus-tui/src/screens/palette.rs` — add Clear widget before overlay render
