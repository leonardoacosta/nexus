## 1. Line Style Metadata

- [x] 1.1 Define a `LineStyle` enum in `crates/nexus-tui/src/app.rs` with variants: `UserPrompt`, `AssistantText`, `ToolHeader`, `ToolInput`, `ToolResult`, `ToolError`, `Error`, `DoneSummary`, `Plain`
- [x] 1.2 Change `StreamViewState.lines` from `Vec<String>` to `Vec<StyledLine>` where `StyledLine` holds `text: String` and `style: LineStyle`
- [x] 1.3 Update `push_line` to accept `StyledLine` instead of plain `String`
- [x] 1.4 Update `flush_partial_buf` to emit lines with `LineStyle::AssistantText`

## 2. Role-Based Formatting in push_command_output

- [x] 2.1 Update the `Text` arm to emit lines with `LineStyle::AssistantText` (white text)
- [x] 2.2 Update the `ToolUse` arm to emit a tool header line (`LineStyle::ToolHeader`) formatted as `⏺ {tool_name}` in bold cyan, followed by an indented input preview line (`LineStyle::ToolInput`) formatted as `  $ {input_preview}` in dim
- [x] 2.3 Update the `ToolResult` arm to emit a result line (`LineStyle::ToolResult`) formatted as `  ✓ {tool_name}: {preview}` (success) or `  ✗ {tool_name}: {preview}` (failure, using `LineStyle::ToolError`)
- [x] 2.4 Update the `Error` arm to emit lines with `LineStyle::Error` (red)
- [x] 2.5 Update the `Done` arm to emit lines with `LineStyle::DoneSummary` (dim green)
- [x] 2.6 Update the user prompt echo in `main.rs` (the `── you ──` line and prompt text) to push `StyledLine` with `LineStyle::UserPrompt` (green)

## 3. Render with Per-Line Colors

- [x] 3.1 Add a `line_style_to_ratatui` helper function in `crates/nexus-tui/src/screens/stream.rs` that maps `LineStyle` to `ratatui::style::Style` using the brand color palette
- [x] 3.2 Update `render_log_view` to apply per-line styles from `StyledLine.style` instead of the uniform `colors::TEXT` style

## 4. Spinner with Elapsed Time

- [x] 4.1 Add `stream_exec_start: Option<Instant>` field to `App` in `crates/nexus-tui/src/app.rs`, initialized to `None`
- [x] 4.2 Set `stream_exec_start = Some(Instant::now())` when `stream_executing` is set to `true` (in the Enter key handler in `main.rs`)
- [x] 4.3 Clear `stream_exec_start = None` when `CommandStreamDone` is received
- [x] 4.4 Update `render_input_bar` in `crates/nexus-tui/src/screens/stream.rs` to compute elapsed seconds from `stream_exec_start` and display as `⠋ executing... (3.2s)`

## 5. Verification

- [x] 5.1 Run `cargo build -p nexus-tui` and confirm clean compilation
- [x] 5.2 Run `cargo clippy -p nexus-tui` with no new warnings
- [ ] 5.3 Manually verify stream view renders: user prompts green, assistant text white, tool headers bold cyan, tool inputs dim, tool results dim, errors red, done line dim green, spinner shows elapsed seconds
