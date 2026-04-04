# Change: Markdown Rendering in Stream Attach View

## Why
Assistant text in the stream attach view renders as raw plaintext — markdown headers (`##`),
code fences (`` ``` ``), tables, bold/italic, and horizontal rules display as literal characters.
This makes the stream view look like a log dump rather than a chat interface. Every competing
terminal AI tool (OpenCode, Toad, OpenClaude) renders markdown with syntax highlighting.

## What Changes
- Add `termimad` crate for markdown-to-terminal rendering
- Parse assistant text through markdown renderer before displaying
- Syntax-highlight code blocks (language-aware via `syntect` or termimad's built-in highlighter)
- Render tables, headers, bold/italic, lists as styled terminal output
- Handle streaming: accumulate partial text, re-render markdown on each flush

## Impact
- Affected specs: `stream-rendering` (new capability spec)
- Affected code: `crates/nexus-tui/src/app.rs` (push_command_output), `crates/nexus-tui/src/screens/stream.rs` (line rendering)
- New dependency: `termimad` (or `tui-markdown`) in `crates/nexus-tui/Cargo.toml`
- Backward compatible: only changes visual rendering, no data model changes
