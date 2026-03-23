## 1. Code Block Clipboard (yank)
- [ ] 1.1 Track code block boundaries in `StreamLine` data (start/end indices of fenced code blocks)
- [ ] 1.2 When cursor is within a code block, `y` extracts the code content (without fences)
- [ ] 1.3 Write to clipboard via OSC 52 escape sequence (works over SSH, no external dep needed)
- [ ] 1.4 Show notification "Copied N lines to clipboard" in status bar

## 2. Thinking/Reasoning Collapse
- [ ] 2.1 Detect thinking/reasoning blocks in assistant output (content between `<thinking>` tags or `> [!thinking]` blocks)
- [ ] 2.2 Render as `CollapsibleBlock` (reuse existing pattern) with summary header "── thinking (N lines) ──"
- [ ] 2.3 Default to collapsed; `Enter` toggles expansion (consistent with tool result collapsibles)

## 3. Stream Search
- [ ] 3.1 Add `SearchState` to `StreamViewState`: query string, match positions, current match index
- [ ] 3.2 `/` in normal mode opens search input overlay at bottom of stream view
- [ ] 3.3 Incremental search: highlight all matches as user types (yellow background on matching text)
- [ ] 3.4 `Enter` confirms search and closes input; `n` jumps to next match, `N` to previous
- [ ] 3.5 `Esc` clears search highlights and returns to normal mode

## 4. Quick Session Tabs
- [ ] 4.1 Track recent session IDs in `App` state (last 9 streamed sessions, ordered by access time)
- [ ] 4.2 `1-9` in stream attach normal mode switches to the Nth recent session
- [ ] 4.3 Show tab indicators in title bar: `[1:oo] [2:nx] [3:nv]` with active tab highlighted
- [ ] 4.4 Switching tabs preserves scroll position and stream buffer of each session

## 5. Inline Diff Rendering
- [ ] 5.1 Detect Edit/Write tool results that contain diff-like output (lines starting with `+`/`-`)
- [ ] 5.2 Render added lines with green foreground, removed lines with red foreground
- [ ] 5.3 Render context lines (no prefix) in normal `TEXT_DIM`

## 6. Validation
- [ ] 6.1 Visual test: code yank works over SSH (OSC 52)
- [ ] 6.2 Visual test: search highlights visible and navigation works
- [ ] 6.3 Visual test: session tabs switch without losing stream history
- [ ] 6.4 Visual test: thinking blocks default collapsed, expand on Enter
- [ ] 6.5 `cargo clippy && cargo test`
