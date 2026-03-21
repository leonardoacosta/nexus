# Change: Collapsible tool output in stream view

## Why

Tool results (especially `Bash`, `Read`, `Grep`) in the stream attach view frequently produce 20-100+ lines of output, pushing the user's conversational context off screen. There is no way to collapse verbose output, forcing users to scroll through long tool dumps to find the agent's reasoning. Collapsing long tool results to a single summary line — expandable on demand — keeps the stream readable without losing detail.

## What Changes

- **Modify** `crates/nexus-tui/src/app.rs` — replace `lines: Vec<String>` in `StreamViewState` with `lines: Vec<StreamLine>` where `StreamLine` is an enum: `Text(String)` | `CollapsibleBlock { header, lines, expanded }`. Update `push_line`, `push_command_output`, scroll helpers, and line-count logic to work with the new type.
- **Modify** `crates/nexus-tui/src/app.rs` — in `push_command_output` for `ToolResult` variant: when `output_preview` exceeds 5 lines, emit a `CollapsibleBlock` instead of multiple `Text` lines. The collapsed header format is `  {icon} {tool_name} [+{n} lines] [Enter] to expand`.
- **Modify** `crates/nexus-tui/src/screens/stream.rs` — update `render_log_view` to handle `StreamLine::CollapsibleBlock`: when collapsed, render the header line with dim styling; when expanded, render header + all contained lines. Adjust visible-line counting for scroll offset.
- **Modify** `crates/nexus-tui/src/main.rs` — in `handle_stream_key`, add Enter key handler that toggles `expanded` on the `CollapsibleBlock` at the current scroll position.

## Impact

- Affected specs: stream-view (NEW capability — stream attach is archived without a live spec)
- Affected code: `crates/nexus-tui/src/{app.rs, screens/stream.rs, main.rs}`
- No breaking changes — internal type refactor, no API surface affected
- Estimated ~120 LOC changed
