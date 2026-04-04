# Change: Stream view message formatting

## Why

The stream attach view currently renders all content in a single color (TEXT gray) with minimal
structure. Tool call lines show as flat `[tool] Bash: cargo build` text. The executing spinner
has no elapsed time indicator. This makes it difficult to visually parse conversation flow --
user prompts, assistant text, tool invocations, and errors all blend together.

## What Changes

- Apply role-based colors in `push_command_output`: user prompt lines in green, assistant text in
  white, tool call headers in bold cyan, tool results in dim, errors in red, done lines in dim green
- Replace the flat `[tool] Name: preview` format with structured inline blocks using a filled
  circle prefix, indented input preview, and a checkmark/cross result line with duration (when
  available)
- Add elapsed time tracking to the executing spinner: record `Instant::now()` when a command
  begins, display elapsed seconds in the spinner line as `(3.2s)`

## Impact

- Affected specs: stream-formatting (NEW capability)
- Affected code:
  - `crates/nexus-tui/src/app.rs` -- add line-level style metadata to `StreamViewState`, add
    `stream_exec_start` field, update `push_command_output` formatting
  - `crates/nexus-tui/src/screens/stream.rs` -- apply per-line styles in `render_log_view`,
    update spinner in `render_input_bar` to show elapsed time
- No proto changes, no agent changes -- purely TUI-side rendering
- ~150 LOC estimated
