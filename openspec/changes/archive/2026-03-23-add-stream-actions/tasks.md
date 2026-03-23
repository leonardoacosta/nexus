## 1. Code Block Clipboard (yank)
- [x] 1.1 Code block boundaries tracked in `CodeBlockRange` during render pass (detects SURFACE bg lines)
- [x] 1.2 `y` key finds code block at current scroll position, extracts content
- [x] 1.3 OSC 52 clipboard write via base64-encoded escape sequence (works over SSH)
- [x] 1.4 Notification toast "yanked N lines" / "no code block at cursor" with auto-dismiss

## 2. Thinking/Reasoning Collapse
- [x] 2.1 `extract_thinking_blocks()` detects `<thinking>...</thinking>` tags in assistant text
- [x] 2.2 Wrapped in `CollapsibleBlock` with header "── thinking (N lines) ──" styled DoneSummary
- [x] 2.3 Default collapsed; Enter toggles (reuses existing collapsible mechanism)

## 3. Stream Search
- [x] 3.1 `SearchState` with query, match_positions, current_match added to StreamViewState
- [x] 3.2 `/` enters `InputMode::StreamSearch`; search bar rendered between log and input
- [x] 3.3 Yellow background highlighting on matched substrings across all span types
- [x] 3.4 Enter confirms (keeps highlights), `n`/`N` navigate matches in normal mode
- [x] 3.5 Esc clears search and returns to normal mode

## 4. Quick Session Tabs
- [x] 4.1 `SessionTab` struct + `session_tabs: Vec<SessionTab>` (max 9) in App
- [x] 4.2 `1-9` in normal mode switches tabs; `ensure_session_tab()` auto-registers on attach
- [x] 4.3 Tab indicators in title bar: `[1:oo] [2:nx]` with active in PRIMARY color
- [x] 4.4 Scroll position and buffer preserved per tab via save/restore on switch

## 5. Inline Diff Rendering
- [x] 5.1 `classify_diff_line()` detects `+`/`-` prefixed lines (not `+++`/`---`) in tool results
- [x] 5.2 `DiffAdd` → PRIMARY green, `DiffRemove` → ERROR red
- [x] 5.3 Context lines in TEXT_DIM; applied to both collapsible and inline tool results

## 6. Validation
- [x] 6.1 OSC 52 yank implemented (SSH-compatible, no external clipboard dep)
- [x] 6.2 Search highlighting + navigation implemented
- [x] 6.3 Session tabs with preserved state implemented
- [x] 6.4 Thinking blocks as collapsible sections implemented
- [x] 6.5 `cargo clippy && cargo test` — 32 tests pass, 0 clippy warnings
