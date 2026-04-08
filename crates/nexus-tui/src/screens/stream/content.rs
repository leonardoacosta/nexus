use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap,
};

use crate::app::{App, CodeBlockRange, LineStyle, StreamLine, colors};

/// Render a `StyledLine` into a `Line`, adding a green left-border for `UserPrompt` lines.
pub fn render_styled_line(s: &crate::app::StyledLine) -> Line<'static> {
    if s.style == LineStyle::UserPrompt {
        Line::from(vec![
            Span::styled("\u{2502} ", Style::default().fg(colors::PRIMARY)),
            Span::styled(s.text.clone(), line_style_to_ratatui(s.style)),
        ])
    } else {
        Line::from(Span::styled(s.text.clone(), line_style_to_ratatui(s.style)))
    }
}

/// Map a `LineStyle` to the ratatui `Style` using the brand color palette.
fn line_style_to_ratatui(style: LineStyle) -> Style {
    match style {
        LineStyle::UserPrompt => Style::default().fg(colors::PRIMARY),
        LineStyle::UserHeader => Style::default()
            .fg(colors::PRIMARY)
            .add_modifier(Modifier::DIM),
        LineStyle::AssistantText => Style::default().fg(Color::White),
        LineStyle::AssistantHeader => Style::default()
            .fg(colors::SECONDARY)
            .add_modifier(Modifier::DIM),
        LineStyle::ToolHeader => Style::default()
            .fg(colors::SECONDARY)
            .add_modifier(Modifier::BOLD),
        LineStyle::ToolInput => Style::default()
            .fg(colors::TEXT_DIM)
            .add_modifier(Modifier::DIM),
        LineStyle::ToolResult => Style::default()
            .fg(colors::TEXT_DIM)
            .add_modifier(Modifier::DIM),
        LineStyle::ToolError => Style::default().fg(colors::ERROR),
        LineStyle::Error => Style::default().fg(colors::ERROR),
        LineStyle::DoneSummary => Style::default()
            .fg(colors::PRIMARY_DIM)
            .add_modifier(Modifier::DIM),
        LineStyle::Plain => Style::default().fg(colors::TEXT),
        LineStyle::DiffAdd => Style::default().fg(colors::PRIMARY),
        LineStyle::DiffRemove => Style::default().fg(colors::ERROR),
    }
}

/// Extract the plain text content from a ratatui `Line`.
fn line_text(line: &Line<'_>) -> String {
    line.spans.iter().map(|s| s.content.as_ref()).collect()
}

/// Check if a display line is a code block line (has SURFACE background).
fn is_code_block_line(line: &Line<'_>) -> bool {
    line.spans
        .iter()
        .any(|s| s.style.bg == Some(colors::SURFACE))
}

/// Apply search highlighting to a `Line`, wrapping matched substrings in yellow
/// background spans. Returns a new `Line` with highlights applied.
fn highlight_search_in_line<'a>(line: Line<'a>, query: &str) -> Line<'a> {
    if query.is_empty() {
        return line;
    }
    let query_lower = query.to_lowercase();
    let mut new_spans: Vec<Span<'a>> = Vec::new();

    for span in line.spans {
        let text = span.content.as_ref();
        let text_lower = text.to_lowercase();
        let base_style = span.style;

        let mut start = 0;
        let mut found = false;
        for (idx, _) in text_lower.match_indices(&query_lower) {
            found = true;
            if idx > start {
                new_spans.push(Span::styled(text[start..idx].to_owned(), base_style));
            }
            new_spans.push(Span::styled(
                text[idx..idx + query.len()].to_owned(),
                base_style.bg(Color::Yellow).fg(Color::Black),
            ));
            start = idx + query.len();
        }
        if found {
            if start < text.len() {
                new_spans.push(Span::styled(text[start..].to_owned(), base_style));
            }
        } else {
            new_spans.push(Span::styled(text.to_owned(), base_style));
        }
    }

    Line::from(new_spans)
}

pub fn render_log_view(frame: &mut Frame, area: Rect, app: &mut App) {
    let visible_height = area.height as usize;

    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => {
            let msg = Paragraph::new(Line::from(vec![Span::styled(
                "No stream data.",
                Style::default().fg(colors::TEXT_DIM),
            )]))
            .block(
                Block::default()
                    .border_type(BorderType::Rounded)
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(colors::TEXT_DIM)),
            )
            .wrap(Wrap { trim: true });
            frame.render_widget(msg, area);
            return;
        }
    };

    let verbosity = sv.verbosity;

    // Update auto-scroll position before rendering.
    sv.update_auto_scroll(visible_height);

    if sv.lines.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "Waiting for events...",
            Style::default().fg(colors::TEXT_DIM),
        )]))
        .block(
            Block::default()
                .border_type(BorderType::Rounded)
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors::TEXT_DIM)),
        )
        .wrap(Wrap { trim: true });
        frame.render_widget(msg, area);
        return;
    }

    // Width for separator lines (leave 1 col for scrollbar).
    let sep_width = area.width.saturating_sub(1) as usize;

    /// Return true for "role header" line styles that get a separator above them.
    fn is_role_header(style: LineStyle) -> bool {
        matches!(
            style,
            LineStyle::UserHeader | LineStyle::AssistantHeader | LineStyle::ToolHeader
        )
    }

    // Expand all StreamLine entries into individual display lines, filtering
    // by the current verbosity level. Track code blocks during expansion.
    let mut display_lines: Vec<Line<'_>> = Vec::new();
    let mut code_blocks: Vec<CodeBlockRange> = Vec::new();
    let mut in_code_block = false;
    let mut code_block_start: usize = 0;
    let mut code_block_content = String::new();
    let mut first_entry = true;

    for entry in &sv.lines {
        if !entry.is_visible(verbosity) {
            continue;
        }
        match entry {
            StreamLine::Styled(s) => {
                // Insert a thin separator before role-header lines (except the very first).
                if is_role_header(s.style) && !first_entry {
                    let sep = "\u{2500}".repeat(sep_width);
                    display_lines.push(Line::from(Span::styled(
                        sep,
                        Style::default().fg(colors::TEXT_DIM),
                    )));
                }
                first_entry = false;
                let line = render_styled_line(s);
                let idx = display_lines.len();
                // Code block lines from markdown have SURFACE background.
                if is_code_block_line(&line) {
                    if !in_code_block {
                        in_code_block = true;
                        code_block_start = idx;
                        code_block_content.clear();
                    }
                    code_block_content.push_str(&line_text(&line));
                    code_block_content.push('\n');
                } else if in_code_block {
                    // End of code block.
                    code_blocks.push(CodeBlockRange {
                        start_line: code_block_start,
                        end_line: idx.saturating_sub(1),
                        content: code_block_content.trim_end().to_string(),
                    });
                    in_code_block = false;
                    code_block_content.clear();
                }
                display_lines.push(line);
            }
            StreamLine::RichText { line } => {
                first_entry = false;
                let idx = display_lines.len();
                if is_code_block_line(line) {
                    if !in_code_block {
                        in_code_block = true;
                        code_block_start = idx;
                        code_block_content.clear();
                    }
                    // Strip the gutter prefix (│ ) from code block content for yank.
                    let text = line_text(line);
                    let stripped = text.strip_prefix("\u{2502} ").unwrap_or(&text);
                    code_block_content.push_str(stripped);
                    code_block_content.push('\n');
                } else if in_code_block {
                    code_blocks.push(CodeBlockRange {
                        start_line: code_block_start,
                        end_line: idx.saturating_sub(1),
                        content: code_block_content.trim_end().to_string(),
                    });
                    in_code_block = false;
                    code_block_content.clear();
                }
                display_lines.push(line.clone());
            }
            StreamLine::CollapsibleBlock {
                header,
                lines,
                expanded,
            } => {
                // Separators before ToolHeader collapsible blocks.
                if is_role_header(header.style) && !first_entry {
                    let sep = "\u{2500}".repeat(sep_width);
                    display_lines.push(Line::from(Span::styled(
                        sep,
                        Style::default().fg(colors::TEXT_DIM),
                    )));
                }
                first_entry = false;
                if in_code_block {
                    let idx = display_lines.len();
                    code_blocks.push(CodeBlockRange {
                        start_line: code_block_start,
                        end_line: idx.saturating_sub(1),
                        content: code_block_content.trim_end().to_string(),
                    });
                    in_code_block = false;
                    code_block_content.clear();
                }
                if *expanded {
                    // Header rendered with normal (non-dim) color.
                    display_lines.push(render_styled_line(header));
                    for body_line in lines {
                        display_lines.push(render_styled_line(body_line));
                    }
                } else {
                    // Collapsed: header only, rendered dim.
                    display_lines.push(Line::from(Span::styled(
                        header.text.clone(),
                        Style::default()
                            .fg(colors::TEXT_DIM)
                            .add_modifier(Modifier::DIM),
                    )));
                }
            }
        }
    }

    // Close any trailing code block.
    if in_code_block && !code_block_content.is_empty() {
        code_blocks.push(CodeBlockRange {
            start_line: code_block_start,
            end_line: display_lines.len().saturating_sub(1),
            content: code_block_content.trim_end().to_string(),
        });
    }

    // Store code blocks for yank.
    sv.code_blocks = code_blocks;

    // Get search state before slicing.
    let search_query: Option<String> = sv
        .search
        .as_ref()
        .filter(|s| !s.query.is_empty())
        .map(|s| s.query.clone());

    // Compute search match positions across all display lines.
    if let Some(ref query) = search_query {
        let query_lower = query.to_lowercase();
        let match_positions: Vec<usize> = display_lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line_text(line).to_lowercase().contains(&query_lower))
            .map(|(i, _)| i)
            .collect();
        if let Some(ref mut search) = sv.search {
            search.match_positions = match_positions;
            if search.current_match >= search.match_positions.len() {
                search.current_match = 0;
            }
        }
    }

    let total_lines = display_lines.len();
    let scroll_offset = sv.scroll_offset;

    // Update app-level scrollbar state so it reflects the current content.
    app.stream_total_lines = total_lines;
    app.stream_scroll_state = ScrollbarState::new(total_lines).position(scroll_offset);

    // Take visible slice.
    let visible_lines: Vec<Line<'_>> = display_lines
        .into_iter()
        .skip(scroll_offset)
        .take(visible_height)
        .map(|line| {
            if let Some(ref query) = search_query {
                highlight_search_in_line(line, query)
            } else {
                line
            }
        })
        .collect();

    // Render notification overlay if present.
    let notification = sv.notification_message.as_ref().map(|(msg, _)| msg.clone());

    // Reserve 1 column on the right for the scrollbar.
    let msg_width = area.width.saturating_sub(1);
    let msg_area = Rect {
        x: area.x,
        y: area.y,
        width: msg_width,
        height: area.height,
    };
    let scrollbar_area = Rect {
        x: area.x + msg_width,
        y: area.y,
        width: 1,
        height: area.height,
    };

    let paragraph = Paragraph::new(visible_lines);
    frame.render_widget(paragraph, msg_area);

    // Render the vertical scrollbar.
    let mut scroll_state = app.stream_scroll_state;
    let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
        .begin_symbol(None)
        .end_symbol(None);
    frame.render_stateful_widget(scrollbar, scrollbar_area, &mut scroll_state);

    // Draw notification toast in the top-right corner of the message area
    // (left of the scrollbar).
    if let Some(msg) = notification {
        let msg_len = msg.len() as u16 + 4; // padding
        if msg_area.width > msg_len {
            let toast_area = Rect {
                x: msg_area.x + msg_area.width - msg_len,
                y: msg_area.y,
                width: msg_len,
                height: 1,
            };
            let toast = Paragraph::new(Line::from(Span::styled(
                format!("  {msg}  "),
                Style::default()
                    .fg(colors::PRIMARY)
                    .bg(colors::SURFACE_HIGHLIGHT),
            )));
            frame.render_widget(toast, toast_area);
        }
    }
}
