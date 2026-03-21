use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, LineStyle, StreamLine, colors};

/// Map a `LineStyle` to the ratatui `Style` using the brand color palette.
fn line_style_to_ratatui(style: LineStyle) -> Style {
    match style {
        LineStyle::UserPrompt => Style::default().fg(colors::PRIMARY),
        LineStyle::AssistantText => Style::default().fg(Color::White),
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

    let chunks = Layout::vertical([
        Constraint::Length(3),          // title bar
        Constraint::Min(1),             // log view
        Constraint::Length(bar_height), // input bar (dynamic)
        Constraint::Length(1),          // status bar
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_log_view(frame, chunks[1], app);
    render_input_bar(frame, chunks[2], app);
    render_status_bar(frame, chunks[3], app);
}

fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let label = sv.map(|s| s.session_label.as_str()).unwrap_or("?");

    // Build the heartbeat badge spans (dot + session type label).
    let badge_spans: Vec<Span<'_>> = if let Some(sv) = sv {
        if let Some(ref stype) = sv.session_type {
            let (dot, dot_style) = if sv.heartbeat_alive {
                // Pulse: alternate between filled (●) and hollow (○) every 10 ticks.
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
    spans.push(Span::styled(
        "  q: back  j/k: scroll  End: follow  Enter: expand/collapse",
        Style::default().fg(colors::TEXT_DIM),
    ));

    let title = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, area);
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

    // Expand all StreamLine entries into individual display lines, then
    // apply scroll offset and take only what fits in the viewport.
    let mut display_lines: Vec<Line<'_>> = Vec::new();
    for entry in &sv.lines {
        match entry {
            StreamLine::Styled(s) => {
                display_lines.push(Line::from(Span::styled(
                    s.text.clone(),
                    line_style_to_ratatui(s.style),
                )));
            }
            StreamLine::CollapsibleBlock {
                header,
                lines,
                expanded,
            } => {
                if *expanded {
                    // Header rendered with normal (non-dim) color.
                    display_lines.push(Line::from(Span::styled(
                        header.text.clone(),
                        line_style_to_ratatui(header.style),
                    )));
                    for body_line in lines {
                        display_lines.push(Line::from(Span::styled(
                            body_line.text.clone(),
                            line_style_to_ratatui(body_line.style),
                        )));
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

    let visible_lines: Vec<Line<'_>> = display_lines
        .into_iter()
        .skip(sv.scroll_offset)
        .take(visible_height)
        .collect();

    let paragraph = Paragraph::new(visible_lines);
    frame.render_widget(paragraph, area);
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
