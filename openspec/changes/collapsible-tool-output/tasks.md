## 1. StreamLine Type

- [ ] 1.1 Define `StreamLine` enum in `app.rs` with variants `Text(String)` and `CollapsibleBlock { header: String, lines: Vec<String>, expanded: bool }`
- [ ] 1.2 Replace `lines: Vec<String>` with `lines: Vec<StreamLine>` in `StreamViewState`
- [ ] 1.3 Add `StreamLine::display_lines(&self) -> usize` method returning 1 for `Text`, 1 for collapsed block, `1 + lines.len()` for expanded block
- [ ] 1.4 Update `push_line` to accept `StreamLine` (or add `push_text` helper that wraps `String` in `Text`)
- [ ] 1.5 Update `MAX_STREAM_LINES` drain logic to count by `StreamLine` entries (not display lines)

## 2. Collapse Logic in push_command_output

- [ ] 2.1 In the `ToolResult` arm of `push_command_output`, count newlines in `output_preview`
- [ ] 2.2 When line count exceeds 5, create a `CollapsibleBlock` with header `  {icon} {tool_name} [+{N} lines] [Enter] to expand` and store the full output lines in `lines`
- [ ] 2.3 When line count is 5 or fewer, retain existing behavior (push individual `Text` lines)

## 3. Render Updates

- [ ] 3.1 Update `render_log_view` in `screens/stream.rs` to iterate `Vec<StreamLine>` instead of `Vec<String>`
- [ ] 3.2 For `Text(s)`: render as current single-line span (unchanged visual)
- [ ] 3.3 For `CollapsibleBlock` (collapsed): render header line with `TEXT_DIM` color
- [ ] 3.4 For `CollapsibleBlock` (expanded): render header with `TEXT` color, then each contained line indented
- [ ] 3.5 Compute visible line count by summing `display_lines()` across all `StreamLine` entries for correct scroll math

## 4. Enter Key Toggle

- [ ] 4.1 In `handle_stream_key` (Normal mode), add `KeyCode::Enter` arm
- [ ] 4.2 Determine which `StreamLine` entry is at the current scroll position by walking `display_lines()` from `scroll_offset`
- [ ] 4.3 If the entry is a `CollapsibleBlock`, toggle its `expanded` field
- [ ] 4.4 After toggling, adjust `scroll_offset` if auto-scroll is enabled (call `update_auto_scroll`)

## 5. Scroll Adjustments

- [ ] 5.1 Update `scroll_down`, `scroll_up`, `page_up`, `page_down` to use total display-line count (sum of `display_lines()`) instead of `lines.len()`
- [ ] 5.2 Update `update_auto_scroll` to use total display-line count
- [ ] 5.3 Update status bar `line_count` display in `render_status_bar` to show entry count or display-line count

## 6. Verification

- [ ] 6.1 `cargo build -p nexus-tui` compiles without errors
- [ ] 6.2 `cargo clippy -p nexus-tui` passes with no warnings
- [ ] 6.3 `cargo fmt --check` passes
