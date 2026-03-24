## 1. Dependency Setup
- [ ] 1.1 Add `syntect` to workspace Cargo.toml with features: `default-syntaxes`, `default-themes`, disable oniguruma if possible (use `fancy-regex` feature for smaller binary)
- [ ] 1.2 Add `syntect = { workspace = true }` to nexus-tui/Cargo.toml

## 2. Language Tag Extraction
- [ ] 2.1 Change `Tag::CodeBlock(_)` (markdown.rs ~line 148) to `Tag::CodeBlock(ref kind)`
- [ ] 2.2 Match `CodeBlockKind::Fenced(lang)` to extract language string
- [ ] 2.3 Store current language tag in MarkdownRenderer state (add field `current_lang: Option<String>`)

## 3. Syntax Highlighting
- [ ] 3.1 Add `SyntaxSet` and `Theme` fields to MarkdownRenderer (or lazy_static/once_cell)
- [ ] 3.2 On code block start, look up syntax definition: `syntax_set.find_syntax_by_token(lang)`
- [ ] 3.3 Create `HighlightLines` for the matched syntax + chosen theme (e.g., `base16-ocean.dark`)
- [ ] 3.4 For each code line (markdown.rs ~lines 258-265), run `highlighter.highlight_line(line, syntax_set)`
- [ ] 3.5 Map syntect `Style { foreground: Color { r, g, b, .. }, .. }` → `ratatui::style::Color::Rgb(r, g, b)`
- [ ] 3.6 Build `Vec<Span>` from highlighted ranges instead of single monochrome Span
- [ ] 3.7 Preserve gutter character `\u{2502}` as first Span (keep existing gutter style)

## 4. Fallback
- [ ] 4.1 If language not recognized (find_syntax_by_token returns None), fall back to current monochrome rendering
- [ ] 4.2 If no language tag (CodeBlockKind::Indented or empty Fenced), use monochrome

## 5. Validation
- [ ] 5.1 `cargo build` passes — check binary size increase (expect ~2MB from syntect assets)
- [ ] 5.2 `cargo test` — all tests pass
- [ ] 5.3 Manual smoke: stream a session with code blocks in rust, python, typescript — verify syntax colors appear
