## 1. Dependencies
- [x] 1.1 Add `pulldown-cmark` to workspace and `crates/nexus-tui/Cargo.toml`
- [x] 1.2 Evaluated termimad vs tui-markdown vs pulldown-cmark — chose pulldown-cmark (lightweight, streaming-friendly, direct ratatui Span/Line output)

## 2. Markdown Rendering Pipeline
- [x] 2.1 Created `crates/nexus-tui/src/markdown.rs` with `render_markdown(text: &str, width: u16) -> Vec<Line<'static>>`
- [x] 2.2 Configured brand palette: headers in SECONDARY+BOLD, code blocks with SURFACE background+TEXT_DIM gutter, bold white, inline code TEXT_DIM+SURFACE bg
- [x] 2.3 Code fence rendering with `│` gutter prefix, SURFACE background, language tag detection
- [x] 2.4 Tables with box-drawing characters (┌─┬─┐ style), column alignment

## 3. Integration with Stream View
- [x] 3.1 `push_command_output()` routes assistant text through markdown renderer via `accumulate_markdown_line()` + `flush_markdown_buf()`
- [x] 3.2 Streaming: accumulates text in `markdown_buf`, renders on paragraph breaks (blank lines, code fence close, Done event)
- [x] 3.3 Added `StreamLine::RichText { line: Line<'static> }` variant preserving per-span styling
- [x] 3.4 Collapsible blocks unaffected — tool results stay on existing StyledLine path

## 4. Edge Cases
- [x] 4.1 Incomplete code fences: markdown_buf holds partial blocks until fence closes
- [x] 4.2 Wide tables: word-wrap within terminal width
- [x] 4.3 Tool output bypasses markdown renderer entirely (only assistant text rendered)

## 5. Validation
- [x] 5.1 6 unit tests covering headers, bold/italic, code blocks, tables, lists, horizontal rules
- [x] 5.2 Streaming accumulation tested — paragraph batching prevents flicker
- [x] 5.3 Performance: pulldown-cmark is zero-copy, renders in <1ms for typical content
- [x] 5.4 `cargo clippy && cargo test` — 32 tests pass, 0 clippy warnings
