## Summary

Add syntax highlighting for code blocks in the stream view using the `syntect` crate. Extract language tags from pulldown-cmark fenced code blocks and apply language-specific coloring.

## Motivation

Code blocks in the stream view render as monochrome text with a gutter bar. The pulldown-cmark parser provides language tags (`CodeBlockKind::Fenced(lang)`) but the current implementation discards them (`Tag::CodeBlock(_)` with underscore). syntect provides comprehensive syntax highlighting with themes.

## Approach

1. Add `syntect` dependency with `default-features = false` + `default-syntaxes` + `default-themes` to minimize binary bloat
2. Extract language tag from `CodeBlockKind::Fenced(lang)` instead of discarding with `_`
3. Initialize `SyntaxSet` and `Theme` at markdown renderer creation
4. For each code block line, run syntect highlighting and map `syntect::Style` RGB values to `ratatui::Color::Rgb()`
5. Fall back to current monochrome rendering for unknown/unspecified languages

## Files Modified

- `crates/nexus-tui/Cargo.toml` — add syntect dependency
- `Cargo.toml` — add syntect to workspace deps
- `crates/nexus-tui/src/markdown.rs` — extract language tag (line 148), apply syntect highlighting in code block rendering (lines 256-265)
