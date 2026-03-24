//! Lightweight markdown-to-ratatui renderer.
//!
//! Converts a markdown string into `Vec<Line<'static>>` styled with the brand
//! color palette. Only assistant text is routed through this module; tool
//! results, errors, and other stream content keep the existing `LineStyle` path.

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::app::colors;

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const STYLE_TEXT: Style = Style::new().fg(colors::TEXT);
const STYLE_BOLD: Style = Style::new().fg(Color::White).add_modifier(Modifier::BOLD);
const STYLE_ITALIC: Style = Style::new().fg(Color::White).add_modifier(Modifier::ITALIC);
const STYLE_BOLD_ITALIC: Style = Style::new()
    .fg(Color::White)
    .add_modifier(Modifier::BOLD)
    .add_modifier(Modifier::ITALIC);
const STYLE_INLINE_CODE: Style = Style::new().fg(colors::TEXT_DIM).bg(colors::SURFACE);
const STYLE_H1: Style = Style::new()
    .fg(colors::SECONDARY)
    .add_modifier(Modifier::BOLD);
const STYLE_H2: Style = Style::new()
    .fg(colors::SECONDARY)
    .add_modifier(Modifier::BOLD);
const STYLE_H3: Style = Style::new().fg(colors::SECONDARY);
const STYLE_CODE_BLOCK: Style = Style::new().fg(colors::TEXT).bg(colors::SURFACE);
const STYLE_CODE_GUTTER: Style = Style::new().fg(colors::TEXT_DIM);
const STYLE_BULLET: Style = Style::new().fg(colors::PRIMARY);
const STYLE_HR: Style = Style::new().fg(colors::TEXT_DIM);
const STYLE_TABLE_BORDER: Style = Style::new().fg(colors::TEXT_DIM);
const STYLE_TABLE_HEADER: Style = Style::new()
    .fg(colors::SECONDARY)
    .add_modifier(Modifier::BOLD);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Render a markdown string into styled ratatui `Line`s.
///
/// `width` is the available terminal columns — used for wrapping long lines and
/// sizing horizontal rules.
pub fn render_markdown(text: &str, width: u16) -> Vec<Line<'static>> {
    let mut renderer = MdRenderer::new(width);
    renderer.render(text);
    renderer.output
}

// ---------------------------------------------------------------------------
// Internal renderer
// ---------------------------------------------------------------------------

/// Tracks which inline modifiers are currently active.
#[derive(Clone, Copy, Default)]
struct InlineStyle {
    bold: bool,
    italic: bool,
    code: bool,
}

impl InlineStyle {
    fn to_ratatui(self) -> Style {
        if self.code {
            return STYLE_INLINE_CODE;
        }
        match (self.bold, self.italic) {
            (true, true) => STYLE_BOLD_ITALIC,
            (true, false) => STYLE_BOLD,
            (false, true) => STYLE_ITALIC,
            (false, false) => STYLE_TEXT,
        }
    }
}

/// Accumulates spans for the current paragraph/line being built, then flushes
/// them as complete `Line`s into `output`.
struct MdRenderer {
    width: u16,
    output: Vec<Line<'static>>,

    /// Spans accumulated for the current logical line.
    current_spans: Vec<Span<'static>>,

    /// Active inline style modifiers.
    inline: InlineStyle,

    /// Active heading level (None = normal text).
    heading: Option<HeadingLevel>,

    /// Inside a fenced/indented code block.
    in_code_block: bool,

    /// Current list nesting. Each entry is `Some(n)` for ordered (current
    /// number) or `None` for unordered.
    list_stack: Vec<Option<u64>>,

    /// Table state: column count and rows accumulated.
    table: Option<TableState>,
}

struct TableState {
    header: Vec<Vec<Span<'static>>>,
    rows: Vec<Vec<Vec<Span<'static>>>>,
    /// Spans being accumulated for the current cell.
    current_cell: Vec<Span<'static>>,
    /// Cells accumulated for the current row.
    current_row: Vec<Vec<Span<'static>>>,
    in_header: bool,
}

impl MdRenderer {
    fn new(width: u16) -> Self {
        Self {
            width,
            output: Vec::new(),
            current_spans: Vec::new(),
            inline: InlineStyle::default(),
            heading: None,
            in_code_block: false,
            list_stack: Vec::new(),
            table: None,
        }
    }

    fn render(&mut self, text: &str) {
        let opts = Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_HEADING_ATTRIBUTES;
        let parser = Parser::new_ext(text, opts);
        let events: Vec<Event<'_>> = parser.collect();

        for event in events {
            match event {
                // ---- Block-level start tags ----
                Event::Start(Tag::Heading { level, .. }) => {
                    self.flush_line();
                    self.heading = Some(level);
                }
                Event::Start(Tag::Paragraph) => {
                    // No-op; text events will accumulate spans.
                }
                Event::Start(Tag::CodeBlock(_)) => {
                    self.flush_line();
                    self.in_code_block = true;
                }
                Event::Start(Tag::List(start)) => {
                    self.flush_line();
                    self.list_stack.push(start);
                }
                Event::Start(Tag::Item) => {
                    self.flush_line();
                    let depth = self.list_stack.len().saturating_sub(1);
                    let indent = "  ".repeat(depth);
                    match self.list_stack.last_mut() {
                        Some(Some(n)) => {
                            let bullet = format!("{indent}{n}. ");
                            *n += 1;
                            self.current_spans.push(Span::styled(bullet, STYLE_BULLET));
                        }
                        Some(None) => {
                            let bullet = format!("{indent}  * ");
                            self.current_spans.push(Span::styled(bullet, STYLE_BULLET));
                        }
                        None => {}
                    }
                }
                Event::Start(Tag::Table(_alignments)) => {
                    self.flush_line();
                    self.table = Some(TableState {
                        header: Vec::new(),
                        rows: Vec::new(),
                        current_cell: Vec::new(),
                        current_row: Vec::new(),
                        in_header: false,
                    });
                }
                Event::Start(Tag::TableHead) => {
                    if let Some(ref mut t) = self.table {
                        t.in_header = true;
                        t.current_row.clear();
                    }
                }
                Event::Start(Tag::TableRow) => {
                    if let Some(ref mut t) = self.table {
                        t.current_row.clear();
                    }
                }
                Event::Start(Tag::TableCell) => {
                    if let Some(ref mut t) = self.table {
                        t.current_cell.clear();
                    }
                }

                // ---- Block-level end tags ----
                Event::End(TagEnd::Heading(_level)) => {
                    self.flush_heading_line();
                    self.heading = None;
                    // Blank line after heading.
                    self.output.push(Line::default());
                }
                Event::End(TagEnd::Paragraph) => {
                    self.flush_line();
                    // Blank line after paragraph.
                    self.output.push(Line::default());
                }
                Event::End(TagEnd::CodeBlock) => {
                    self.in_code_block = false;
                }
                Event::End(TagEnd::List(_)) => {
                    self.flush_line();
                    self.list_stack.pop();
                    if self.list_stack.is_empty() {
                        self.output.push(Line::default());
                    }
                }
                Event::End(TagEnd::Item) => {
                    self.flush_line();
                }
                Event::End(TagEnd::TableCell) => {
                    if let Some(ref mut t) = self.table {
                        let cell = std::mem::take(&mut t.current_cell);
                        t.current_row.push(cell);
                    }
                }
                Event::End(TagEnd::TableHead) => {
                    if let Some(ref mut t) = self.table {
                        t.header = std::mem::take(&mut t.current_row);
                        t.in_header = false;
                    }
                }
                Event::End(TagEnd::TableRow) => {
                    if let Some(ref mut t) = self.table {
                        let row = std::mem::take(&mut t.current_row);
                        t.rows.push(row);
                    }
                }
                Event::End(TagEnd::Table) => {
                    if let Some(table) = self.table.take() {
                        self.render_table(table);
                    }
                }

                // ---- Inline style toggles ----
                Event::Start(Tag::Strong) => self.inline.bold = true,
                Event::End(TagEnd::Strong) => self.inline.bold = false,
                Event::Start(Tag::Emphasis) => self.inline.italic = true,
                Event::End(TagEnd::Emphasis) => self.inline.italic = false,

                // ---- Leaf content ----
                Event::Text(cow) => {
                    let s = cow.into_string();
                    if self.in_code_block {
                        // Render each line of the code block with gutter.
                        for code_line in s.split('\n') {
                            self.output.push(Line::from(vec![
                                Span::styled("\u{2502} ", STYLE_CODE_GUTTER),
                                Span::styled(code_line.to_owned(), STYLE_CODE_BLOCK),
                            ]));
                        }
                    } else if let Some(ref mut table) = self.table {
                        let style = if table.in_header {
                            STYLE_TABLE_HEADER
                        } else {
                            self.inline.to_ratatui()
                        };
                        table.current_cell.push(Span::styled(s, style));
                    } else if self.heading.is_some() {
                        // Heading text — styled in flush_heading_line.
                        self.current_spans.push(Span::raw(s));
                    } else {
                        self.current_spans
                            .push(Span::styled(s, self.inline.to_ratatui()));
                    }
                }
                Event::Code(cow) => {
                    let s = cow.into_string();
                    if let Some(ref mut table) = self.table {
                        table.current_cell.push(Span::styled(s, STYLE_INLINE_CODE));
                    } else {
                        self.current_spans.push(Span::styled(s, STYLE_INLINE_CODE));
                    }
                }
                Event::SoftBreak => {
                    // Soft break = space in CommonMark.
                    if let Some(ref mut table) = self.table {
                        table.current_cell.push(Span::raw(" ".to_owned()));
                    } else {
                        self.current_spans.push(Span::raw(" ".to_owned()));
                    }
                }
                Event::HardBreak => {
                    self.flush_line();
                }
                Event::Rule => {
                    self.flush_line();
                    let rule = "\u{2500}".repeat(self.width.saturating_sub(2) as usize);
                    self.output.push(Line::from(Span::styled(rule, STYLE_HR)));
                    self.output.push(Line::default());
                }

                // Ignore everything else (footnotes, HTML, etc.)
                _ => {}
            }
        }

        // Flush any trailing content.
        self.flush_line();

        // Trim trailing blank lines.
        while self.output.last().is_some_and(|l| l.spans.is_empty()) {
            self.output.pop();
        }
    }

    /// Flush accumulated spans as a single `Line`, applying word-wrap if needed.
    fn flush_line(&mut self) {
        if self.current_spans.is_empty() {
            return;
        }
        let spans = std::mem::take(&mut self.current_spans);
        let wrapped = self.wrap_spans(spans, self.width as usize);
        self.output.extend(wrapped);
    }

    /// Flush a heading line with the appropriate heading style applied to all
    /// spans. Adds a prefix marker for h1/h2/h3.
    fn flush_heading_line(&mut self) {
        if self.current_spans.is_empty() {
            return;
        }
        let spans = std::mem::take(&mut self.current_spans);
        let level = self.heading.unwrap_or(HeadingLevel::H3);
        let (prefix, style) = match level {
            HeadingLevel::H1 => ("# ", STYLE_H1),
            HeadingLevel::H2 => ("## ", STYLE_H2),
            HeadingLevel::H3 => ("### ", STYLE_H3),
            HeadingLevel::H4 => ("#### ", STYLE_H3),
            HeadingLevel::H5 => ("##### ", STYLE_H3),
            HeadingLevel::H6 => ("###### ", STYLE_H3),
        };
        let mut styled: Vec<Span<'static>> = Vec::with_capacity(spans.len() + 1);
        styled.push(Span::styled(prefix.to_owned(), style));
        for sp in spans {
            styled.push(Span::styled(sp.content.into_owned(), style));
        }
        self.output.push(Line::from(styled));
    }

    /// Word-wrap a list of spans to fit within `max_width` columns.
    ///
    /// Returns one or more `Line`s. Continuation lines inherit the style of the
    /// span that was split.
    fn wrap_spans(&self, spans: Vec<Span<'static>>, max_width: usize) -> Vec<Line<'static>> {
        if max_width == 0 {
            return vec![Line::from(spans)];
        }

        // Fast path: measure total width; if it fits, emit as-is.
        let total: usize = spans.iter().map(|s| s.width()).sum();
        if total <= max_width {
            return vec![Line::from(spans)];
        }

        // Slow path: character-level splitting.
        let mut lines: Vec<Line<'static>> = Vec::new();
        let mut current: Vec<Span<'static>> = Vec::new();
        let mut col: usize = 0;

        for span in spans {
            let style = span.style;
            let text: String = span.content.into_owned();
            let mut buf = String::new();

            for ch in text.chars() {
                if col >= max_width {
                    // Emit buffered content, start new line.
                    if !buf.is_empty() {
                        current.push(Span::styled(buf.clone(), style));
                        buf.clear();
                    }
                    lines.push(Line::from(std::mem::take(&mut current)));
                    col = 0;
                }
                buf.push(ch);
                col += 1;
            }
            if !buf.is_empty() {
                current.push(Span::styled(buf, style));
            }
        }
        if !current.is_empty() {
            lines.push(Line::from(current));
        }
        lines
    }

    /// Render a completed table into `self.output`.
    fn render_table(&mut self, table: TableState) {
        let col_count = table.header.len();
        if col_count == 0 {
            return;
        }

        // Compute column widths from content.
        let mut widths: Vec<usize> = table
            .header
            .iter()
            .map(|spans| span_text_width(spans))
            .collect();
        for row in &table.rows {
            for (i, cell) in row.iter().enumerate() {
                if i < widths.len() {
                    widths[i] = widths[i].max(span_text_width(cell));
                }
            }
        }

        // Cap total table width to terminal width - 4 (for outer borders + padding).
        let max_table = (self.width as usize).saturating_sub(4);
        let total_content: usize = widths.iter().sum();
        let separators = (col_count.saturating_sub(1)) * 3; // " | "
        if total_content + separators > max_table && total_content > 0 {
            let scale = max_table.saturating_sub(separators) as f64 / total_content as f64;
            for w in &mut widths {
                *w = ((*w as f64 * scale).floor() as usize).max(1);
            }
        }

        // Helper to render a row of cells.
        let render_row = |widths: &[usize], cells: &[Vec<Span<'static>>]| -> Line<'static> {
            let mut spans: Vec<Span<'static>> = Vec::new();
            spans.push(Span::styled("\u{2502} ", STYLE_TABLE_BORDER));
            for (i, cell) in cells.iter().enumerate() {
                let w = widths.get(i).copied().unwrap_or(0);
                let content_width = span_text_width(cell);
                // Emit cell spans (may be truncated).
                let mut remaining = w;
                for sp in cell {
                    let text: &str = &sp.content;
                    if remaining == 0 {
                        break;
                    }
                    if text.len() <= remaining {
                        spans.push(sp.clone());
                        remaining -= text.len();
                    } else {
                        let truncated: String = text.chars().take(remaining).collect();
                        remaining = 0;
                        spans.push(Span::styled(truncated, sp.style));
                    }
                }
                // Pad.
                if content_width < w {
                    spans.push(Span::raw(" ".repeat(w - content_width)));
                }
                if i + 1 < col_count {
                    spans.push(Span::styled(" \u{2502} ", STYLE_TABLE_BORDER));
                }
            }
            spans.push(Span::styled(" \u{2502}", STYLE_TABLE_BORDER));
            Line::from(spans)
        };

        // Separator line.
        let sep_line = || -> Line<'static> {
            let mut s = String::from("\u{251C}");
            for (i, w) in widths.iter().enumerate() {
                s.push_str(&"\u{2500}".repeat(w + 2)); // +2 for padding
                if i + 1 < col_count {
                    s.push('\u{253C}');
                }
            }
            s.push('\u{2524}');
            Line::from(Span::styled(s, STYLE_TABLE_BORDER))
        };

        // Top border.
        let mut top = String::from("\u{250C}");
        for (i, w) in widths.iter().enumerate() {
            top.push_str(&"\u{2500}".repeat(w + 2));
            if i + 1 < col_count {
                top.push('\u{252C}');
            }
        }
        top.push('\u{2510}');
        self.output
            .push(Line::from(Span::styled(top, STYLE_TABLE_BORDER)));

        // Header row.
        self.output.push(render_row(&widths, &table.header));
        self.output.push(sep_line());

        // Body rows.
        for row in &table.rows {
            self.output.push(render_row(&widths, row));
        }

        // Bottom border.
        let mut bot = String::from("\u{2514}");
        for (i, w) in widths.iter().enumerate() {
            bot.push_str(&"\u{2500}".repeat(w + 2));
            if i + 1 < col_count {
                bot.push('\u{2534}');
            }
        }
        bot.push('\u{2518}');
        self.output
            .push(Line::from(Span::styled(bot, STYLE_TABLE_BORDER)));
        self.output.push(Line::default());
    }
}

/// Compute the total character width of a slice of spans.
fn span_text_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|s| s.content.len()).sum()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passthrough() {
        let lines = render_markdown("Hello world", 80);
        assert_eq!(lines.len(), 1);
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("Hello world"));
    }

    #[test]
    fn heading_renders_with_prefix() {
        let lines = render_markdown("# Title", 80);
        assert!(!lines.is_empty());
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("# Title"));
    }

    #[test]
    fn code_block_has_gutter() {
        let md = "```\nfn main() {}\n```";
        let lines = render_markdown(md, 80);
        // Should contain the gutter character.
        let has_gutter = lines
            .iter()
            .any(|l| l.spans.iter().any(|s| s.content.contains('\u{2502}')));
        assert!(has_gutter, "code block should have gutter");
    }

    #[test]
    fn horizontal_rule() {
        let lines = render_markdown("---", 40);
        assert!(!lines.is_empty());
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains('\u{2500}'));
    }

    #[test]
    fn unordered_list() {
        let md = "- item one\n- item two";
        let lines = render_markdown(md, 80);
        assert!(lines.len() >= 2);
        let all_text: String = lines
            .iter()
            .flat_map(|l| l.spans.iter().map(|s| s.content.as_ref().to_owned()))
            .collect::<Vec<_>>()
            .join("");
        assert!(all_text.contains("item one"));
        assert!(all_text.contains("item two"));
    }

    #[test]
    fn table_renders() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |";
        let lines = render_markdown(md, 80);
        // Should have at least 5 lines (top border, header, separator, row, bottom border).
        assert!(
            lines.len() >= 5,
            "table should have >= 5 lines, got {}",
            lines.len()
        );
    }

    #[test]
    fn h2_header_renders_with_double_hash_prefix() {
        let lines = render_markdown("## Section", 80);
        assert!(!lines.is_empty());
        let first_span_text = lines[0].spans.first().map(|s| s.content.as_ref()).unwrap_or("");
        assert_eq!(first_span_text, "## ", "H2 should have '## ' prefix span");
    }

    #[test]
    fn h3_header_renders_with_triple_hash_prefix() {
        let lines = render_markdown("### Subsection", 80);
        assert!(!lines.is_empty());
        let first_span_text = lines[0].spans.first().map(|s| s.content.as_ref()).unwrap_or("");
        assert_eq!(first_span_text, "### ", "H3 should have '### ' prefix span");
    }

    #[test]
    fn code_block_each_line_has_gutter() {
        let md = "```\nline one\nline two\n```";
        let lines = render_markdown(md, 80);
        // Both content lines should have the box-drawing gutter character.
        let gutter_lines: Vec<_> = lines
            .iter()
            .filter(|l| l.spans.iter().any(|s| s.content.as_ref() == "\u{2502} "))
            .collect();
        assert!(
            gutter_lines.len() >= 2,
            "expected at least 2 gutter lines, got {}",
            gutter_lines.len()
        );
    }

    #[test]
    fn inline_code_uses_distinct_style() {
        let lines = render_markdown("Use `cargo test` here", 80);
        assert!(!lines.is_empty());
        // The inline code span should have bg=SURFACE styling.
        let has_inline_code = lines[0].spans.iter().any(|s| s.content.as_ref() == "cargo test");
        assert!(has_inline_code, "inline code content should appear as a span");
    }

    #[test]
    fn bold_text_appears_in_output() {
        let lines = render_markdown("**important**", 80);
        assert!(!lines.is_empty());
        let text: String = lines[0].spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(text.contains("important"));
    }
}
