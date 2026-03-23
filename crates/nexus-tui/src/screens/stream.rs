use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, CodeBlockRange, InputMode, LineStyle, StreamLine, StreamVerbosity, colors};

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

/// Compute the height in terminal rows for the input bar based on the number
/// of newlines in the stream input buffer.
///
/// The bar always shows at least 1 content line (plus 1 for the border = 2
/// minimum rows, but we keep the block border so add 1). Cap at 5 content
/// lines (6 rows total).
fn input_bar_height(stream_input: &str) -> u16 {
    let line_count = stream_input.lines().count().max(1);
    let clamped = line_count.min(5) as u16;
    clamped + 1 // +1 for the TOP border drawn by the block
}

/// Render the stream attach view.
pub fn render_stream(frame: &mut Frame, app: &mut App) {
    let area = frame.area();

    let bar_height = if app.stream_executing {
        2 // executing spinner: 1 content line + 1 border
    } else {
        input_bar_height(&app.stream_input)
    };

    // Reserve 1 row for search bar when in search mode.
    let show_search_bar = app.input_mode == InputMode::StreamSearch
        || app
            .stream_view
            .as_ref()
            .is_some_and(|sv| sv.search.is_some());

    let chunks = if show_search_bar {
        Layout::vertical([
            Constraint::Length(3),          // title bar
            Constraint::Min(1),             // log view
            Constraint::Length(1),          // search bar
            Constraint::Length(bar_height), // input bar (dynamic)
            Constraint::Length(1),          // status bar
        ])
        .split(area)
    } else {
        // Use a 5-element layout with search bar height 0 to keep indices consistent.
        Layout::vertical([
            Constraint::Length(3),          // title bar
            Constraint::Min(1),             // log view
            Constraint::Length(0),          // search bar (hidden)
            Constraint::Length(bar_height), // input bar (dynamic)
            Constraint::Length(1),          // status bar
        ])
        .split(area)
    };

    render_title_bar(frame, chunks[0], app);
    render_log_view(frame, chunks[1], app);
    if show_search_bar {
        render_search_bar(frame, chunks[2], app);
    }
    render_input_bar(frame, chunks[3], app);
    render_status_bar(frame, chunks[4], app);
}

fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let label = sv.map(|s| s.session_label.as_str()).unwrap_or("?");

    // Build the heartbeat badge spans (dot + session type label).
    let badge_spans: Vec<Span<'_>> = if let Some(sv) = sv {
        if let Some(ref stype) = sv.session_type {
            let (dot, dot_style) = if sv.heartbeat_alive {
                // Pulse: alternate between filled and hollow every 10 ticks.
                if (app.tick_count / 10).is_multiple_of(2) {
                    ("\u{25CF}", Style::default().fg(colors::PRIMARY)) // ●
                } else {
                    ("\u{25CB}", Style::default().fg(colors::PRIMARY_DIM)) // ○
                }
            } else {
                // Stale — static dim hollow dot.
                ("\u{25CB}", Style::default().fg(colors::TEXT_DIM)) // ○
            };
            vec![
                Span::styled("  ", Style::default()),
                Span::styled(dot, dot_style),
                Span::styled(
                    format!(" {stype}"),
                    Style::default()
                        .fg(colors::TEXT_DIM)
                        .add_modifier(Modifier::DIM),
                ),
            ]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    let mut spans = vec![
        Span::styled(
            "STREAM ATTACH",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  {label}"),
            Style::default()
                .fg(colors::SECONDARY)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    spans.extend(badge_spans);

    // Session tab indicators: [1:label] [2:label] ...
    if !app.session_tabs.is_empty() {
        spans.push(Span::styled("  ", Style::default()));
        for (i, tab) in app.session_tabs.iter().enumerate() {
            let tab_label = tab.project.as_deref().unwrap_or(&tab.session_label);
            // Truncate label to 6 chars.
            let short: String = tab_label.chars().take(6).collect();
            let is_active = app.active_tab == Some(i);
            let style = if is_active {
                Style::default()
                    .fg(colors::PRIMARY)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors::TEXT_DIM)
            };
            spans.push(Span::styled(format!("[{}:{short}]", i + 1), style));
            spans.push(Span::styled(" ", Style::default()));
        }
    }

    spans.push(Span::styled(
        "  q: back  j/k: scroll  /: search  y: yank  v: filter",
        Style::default().fg(colors::TEXT_DIM),
    ));

    let title = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, area);
}

/// Render a `StyledLine` into a `Line`, adding a green left-border for `UserPrompt` lines.
fn render_styled_line(s: &crate::app::StyledLine) -> Line<'static> {
    if s.style == LineStyle::UserPrompt {
        Line::from(vec![
            Span::styled("\u{2502} ", Style::default().fg(colors::PRIMARY)),
            Span::styled(s.text.clone(), line_style_to_ratatui(s.style)),
        ])
    } else {
        Line::from(Span::styled(s.text.clone(), line_style_to_ratatui(s.style)))
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

fn render_log_view(frame: &mut Frame, area: Rect, app: &mut App) {
    let visible_height = area.height as usize;

    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => {
            let msg = Paragraph::new(Line::from(vec![Span::styled(
                "No stream data.",
                Style::default().fg(colors::TEXT_DIM),
            )]));
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
        )]));
        frame.render_widget(msg, area);
        return;
    }

    // Expand all StreamLine entries into individual display lines, filtering
    // by the current verbosity level. Track code blocks during expansion.
    let mut display_lines: Vec<Line<'_>> = Vec::new();
    let mut code_blocks: Vec<CodeBlockRange> = Vec::new();
    let mut in_code_block = false;
    let mut code_block_start: usize = 0;
    let mut code_block_content = String::new();

    for entry in &sv.lines {
        if !entry.is_visible(verbosity) {
            continue;
        }
        match entry {
            StreamLine::Styled(s) => {
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

    let scroll_offset = sv.scroll_offset;

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

    let paragraph = Paragraph::new(visible_lines);
    frame.render_widget(paragraph, area);

    // Draw notification toast in the top-right corner of the log area.
    if let Some(msg) = notification {
        let msg_len = msg.len() as u16 + 4; // padding
        if area.width > msg_len {
            let toast_area = Rect {
                x: area.x + area.width - msg_len,
                y: area.y,
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

fn render_search_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();

    let (query, current, total) = if let Some(sv) = sv {
        if let Some(ref search) = sv.search {
            (
                search.query.as_str(),
                if search.match_positions.is_empty() {
                    0
                } else {
                    search.current_match + 1
                },
                search.match_positions.len(),
            )
        } else {
            ("", 0, 0)
        }
    } else {
        ("", 0, 0)
    };

    let in_search_mode = app.input_mode == InputMode::StreamSearch;

    let mut spans = vec![
        Span::styled(
            " / ",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(query.to_owned(), Style::default().fg(colors::TEXT)),
    ];

    if in_search_mode {
        spans.push(Span::styled(
            "\u{2588}",
            Style::default().fg(colors::PRIMARY),
        ));
    }

    spans.push(Span::styled(
        format!("  ({current}/{total} matches)"),
        Style::default().fg(colors::TEXT_DIM),
    ));

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(bar, area);
}

fn render_input_bar(frame: &mut Frame, area: Rect, app: &App) {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(colors::TEXT_DIM));

    if app.stream_executing {
        // Show spinner during execution with elapsed time.
        let spinner_chars = [
            '\u{280B}', '\u{2819}', '\u{2839}', '\u{2838}', '\u{283C}', '\u{2834}', '\u{2826}',
            '\u{2827}', '\u{2807}', '\u{280F}',
        ];
        let idx = (app.tick_count / 3) % spinner_chars.len();
        let spinner = spinner_chars[idx];
        let elapsed = app
            .stream_exec_start
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let content = Paragraph::new(Line::from(vec![Span::styled(
            format!(" {spinner} executing... ({elapsed:.1}s)"),
            Style::default().fg(colors::WARNING),
        )]))
        .block(block);
        frame.render_widget(content, area);
    } else if app.stream_input.is_empty() {
        // Show placeholder text when the buffer is empty and not executing.
        let content = Paragraph::new(Line::from(vec![
            Span::styled(" > ", Style::default().fg(colors::PRIMARY)),
            Span::styled(
                "type a prompt, Ctrl+E for editor",
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            ),
        ]))
        .block(block);
        frame.render_widget(content, area);
    } else {
        // Multi-line input: render each line of the buffer with the prompt prefix
        // on the first line and a continuation marker on subsequent lines.
        // Show a block cursor after the last character on the last line.
        let input_lines: Vec<&str> = app.stream_input.split('\n').collect();
        let line_count = input_lines.len();

        // Only render up to 5 lines (the layout already caps height to 5+1).
        let visible_lines: Vec<Line<'_>> = input_lines
            .iter()
            .enumerate()
            .take(5)
            .map(|(i, text)| {
                let is_last = i == line_count - 1;
                if i == 0 {
                    if is_last {
                        Line::from(vec![
                            Span::styled(" > ", Style::default().fg(colors::PRIMARY)),
                            Span::styled(*text, Style::default().fg(colors::TEXT)),
                            Span::styled("\u{2588}", Style::default().fg(colors::PRIMARY)),
                        ])
                    } else {
                        Line::from(vec![
                            Span::styled(" > ", Style::default().fg(colors::PRIMARY)),
                            Span::styled(*text, Style::default().fg(colors::TEXT)),
                        ])
                    }
                } else if is_last {
                    Line::from(vec![
                        Span::styled(" | ", Style::default().fg(colors::TEXT_DIM)),
                        Span::styled(*text, Style::default().fg(colors::TEXT)),
                        Span::styled("\u{2588}", Style::default().fg(colors::PRIMARY)),
                    ])
                } else {
                    Line::from(vec![
                        Span::styled(" | ", Style::default().fg(colors::TEXT_DIM)),
                        Span::styled(*text, Style::default().fg(colors::TEXT)),
                    ])
                }
            })
            .collect();

        let content = Paragraph::new(visible_lines).block(block);
        frame.render_widget(content, area);
    }
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let line_count = sv.map(|s| s.total_display_lines()).unwrap_or(0);
    let auto_scroll = sv.is_some_and(|s| s.auto_scroll);

    let scroll_indicator = if auto_scroll {
        "\u{25BC} follow" // ▼ follow
    } else {
        "\u{25B2} scrolled" // ▲ scrolled
    };

    let mut spans: Vec<Span<'_>> = vec![Span::styled(
        format!(" {line_count} events \u{00B7} {scroll_indicator}"),
        Style::default().fg(colors::TEXT_DIM),
    )];

    if let Some(sv) = sv {
        // Verbosity indicator
        let verbosity_label = match sv.verbosity {
            StreamVerbosity::Minimal => "M",
            StreamVerbosity::Normal => "N",
            StreamVerbosity::Verbose => "V",
        };
        spans.push(Span::styled(
            format!(" \u{00B7} [{verbosity_label}]"),
            Style::default().fg(colors::TEXT_DIM),
        ));

        // System event count
        if sv.system_event_count > 0 {
            spans.push(Span::styled(
                format!(" \u{00B7} {} sys", sv.system_event_count),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }

        // Model name
        if let Some(ref model) = sv.model {
            spans.push(Span::styled(
                format!(" \u{00B7} {model}"),
                Style::default().fg(colors::SECONDARY),
            ));
        }

        // Rate limit utilization with color coding
        if let Some(rl) = sv.rate_limit_utilization {
            let pct = (rl * 100.0).round() as u32;
            let rl_color = if rl < 0.50 {
                colors::PRIMARY // green
            } else if rl < 0.80 {
                colors::WARNING // yellow
            } else {
                colors::ERROR // red
            };
            spans.push(Span::styled(
                format!(" \u{00B7} RL: {pct}%"),
                Style::default().fg(rl_color),
            ));
        }

        // Total cost
        if let Some(cost) = sv.total_cost_usd {
            spans.push(Span::styled(
                format!(" \u{00B7} ${cost:.2}"),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }
    }

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}
