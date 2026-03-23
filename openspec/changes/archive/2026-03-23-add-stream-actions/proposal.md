# Change: Stream View Power Actions

## Why
The stream attach view is read-heavy but action-poor. Users watch long sessions but can't act on
the content — no way to copy code blocks, collapse verbose sections, search history, or switch
sessions without navigating back to the dashboard. Competing tools (Streamdown, Conduit, OpenCode)
provide code-block clipboard, search, and quick session switching.

## What Changes
- Code block yank: `y` copies the code block under cursor to clipboard (OSC 52)
- Thinking/reasoning collapse: extended thinking blocks render as collapsible (default collapsed)
- Stream search: `/` opens search overlay, highlights matches, `n`/`N` to navigate
- Quick session tabs: `1-9` switches between recent sessions without dashboard round-trip
- Inline diff rendering: Edit/Write tool results show colored diff (green adds, red removes)

## Impact
- Affected specs: `stream-rendering` (modify capability spec)
- Affected code: `crates/nexus-tui/src/app.rs`, `crates/nexus-tui/src/screens/stream.rs`
- New dependency: `copypasta-ext` or OSC 52 direct escape (for clipboard)
- Moderate effort — each feature is independently implementable
