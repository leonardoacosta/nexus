use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Clear, Paragraph};

use crate::app::{App, InputMode, colors};

/// Render the command palette overlay.
///
/// The palette is drawn as a centered floating panel: input line at top,
/// filtered results below.
pub fn render_palette(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Center the palette: 60% width, up to 20 rows tall.
    let palette_area = area.centered(Constraint::Percentage(60), Constraint::Length(20));

    // Clear the overlay area first to avoid artifacts from the screen beneath.
    frame.render_widget(Clear, palette_area);

    // Split into input line + results.
    let chunks = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).split(palette_area);

    render_input_line(frame, chunks[0], app);
    render_results(frame, chunks[1], app);
}

fn render_input_line(frame: &mut Frame, area: Rect, app: &App) {
    let cursor = if app.input_mode == InputMode::PaletteInput {
        "\u{2588}" // block cursor
    } else {
        ""
    };

    let line = Line::from(vec![
        Span::styled(
            " > ",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(app.palette_query.clone(), Style::default().fg(colors::TEXT)),
        Span::styled(cursor, Style::default().fg(colors::PRIMARY)),
    ]);

    let paragraph = Paragraph::new(line).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(paragraph, area);
}

/// Task 11.3: Produce spans for `label` with matched characters highlighted.
/// Matched substring characters are rendered with a yellow background.
fn highlight_match<'a>(label: &str, query: &str, bg: ratatui::style::Color) -> Vec<Span<'a>> {
    let label_lower = label.to_ascii_lowercase();
    let normal_style = Style::default().fg(colors::TEXT).bg(bg);
    let highlight_style = Style::default()
        .fg(Color::Black)
        .bg(Color::Yellow)
        .add_modifier(Modifier::BOLD);

    if let Some(pos) = label_lower.find(query) {
        // Substring match — highlight the matched region.
        let end = pos + query.len();
        let mut spans = Vec::new();
        if pos > 0 {
            spans.push(Span::styled(label[..pos].to_owned(), normal_style));
        }
        spans.push(Span::styled(label[pos..end].to_owned(), highlight_style));
        if end < label.len() {
            spans.push(Span::styled(label[end..].to_owned(), normal_style));
        }
        spans
    } else {
        // Subsequence match — highlight each matching character individually.
        let mut spans: Vec<Span<'a>> = Vec::new();
        let mut q_chars = query.chars().peekable();
        let mut segment_start = 0;
        for (byte_pos, ch) in label.char_indices() {
            if let Some(&qch) = q_chars.peek() {
                if ch.to_ascii_lowercase() == qch {
                    // Flush normal segment before this char.
                    if byte_pos > segment_start {
                        spans.push(Span::styled(
                            label[segment_start..byte_pos].to_owned(),
                            normal_style,
                        ));
                    }
                    let end = byte_pos + ch.len_utf8();
                    spans.push(Span::styled(
                        label[byte_pos..end].to_owned(),
                        highlight_style,
                    ));
                    segment_start = end;
                    q_chars.next();
                }
            } else {
                break;
            }
        }
        // Flush trailing normal segment.
        if segment_start < label.len() {
            spans.push(Span::styled(
                label[segment_start..].to_owned(),
                normal_style,
            ));
        }
        if spans.is_empty() {
            spans.push(Span::styled(label.to_owned(), normal_style));
        }
        spans
    }
}

fn render_results(frame: &mut Frame, area: Rect, app: &App) {
    if app.palette_results.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "  no matches",
            Style::default().fg(colors::TEXT_DIM),
        )]))
        .style(Style::default().bg(colors::SURFACE));
        frame.render_widget(msg, area);
        return;
    }

    let visible = area.height as usize;
    // Scroll so that the selected item is visible.
    let scroll_offset = if app.palette_selected >= visible {
        app.palette_selected.saturating_sub(visible / 2)
    } else {
        0
    };

    let query = app.palette_query.to_ascii_lowercase();

    let lines: Vec<Line<'_>> = app
        .palette_results
        .iter()
        .enumerate()
        .skip(scroll_offset)
        .take(visible)
        .map(|(idx, entry)| {
            let is_selected = idx == app.palette_selected;
            let bg = if is_selected {
                colors::PRIMARY_DIM
            } else {
                colors::SURFACE
            };
            let indicator = if is_selected { "\u{25B6} " } else { "  " };

            // Task 11.3: Highlight matched substring characters in the label.
            let label_spans = if !query.is_empty() {
                highlight_match(&entry.label, &query, bg)
            } else {
                vec![Span::styled(
                    entry.label.clone(),
                    Style::default().fg(colors::TEXT).bg(bg),
                )]
            };

            let mut spans = vec![Span::styled(
                format!(" {indicator}"),
                Style::default().fg(colors::PRIMARY).bg(bg),
            )];
            spans.extend(label_spans);
            Line::from(spans)
        })
        .collect();

    let paragraph = Paragraph::new(lines).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(paragraph, area);
}

/// Render the start-session wizard overlay (agent select / project input / cwd input).
pub fn render_start_session(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Center the start-session wizard: 50% width, 12 rows tall.
    let panel_area = area.centered(Constraint::Percentage(50), Constraint::Length(12));

    // Clear behind the overlay to prevent artifacts.
    frame.render_widget(Clear, panel_area);

    match app.input_mode {
        InputMode::StartSessionAgent => render_agent_select(frame, panel_area, app),
        InputMode::StartSessionProjectSelect => render_project_select(frame, panel_area, app),
        InputMode::StartSessionCwd => render_text_prompt(frame, panel_area, "cwd:", &app.start_cwd),
        _ => {}
    }
}

fn render_agent_select(frame: &mut Frame, area: Rect, app: &App) {
    let connected = app.connected_agents();
    let mut lines: Vec<Line<'_>> = Vec::new();

    lines.push(Line::from(vec![Span::styled(
        " select agent (j/k, Enter):",
        Style::default()
            .fg(colors::PRIMARY)
            .add_modifier(Modifier::BOLD),
    )]));

    for (idx, agent) in connected.iter().enumerate() {
        let is_selected = idx == app.start_agent_idx;
        let bg = if is_selected {
            colors::PRIMARY_DIM
        } else {
            colors::SURFACE
        };
        let indicator = if is_selected { "\u{25B6} " } else { "  " };
        lines.push(Line::from(vec![
            Span::styled(
                format!(" {indicator}"),
                Style::default().fg(colors::PRIMARY).bg(bg),
            ),
            Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT).bg(bg),
            ),
            Span::styled(
                format!("  ({}:{})", agent.info.host, agent.info.port),
                Style::default().fg(colors::TEXT_DIM).bg(bg),
            ),
        ]));
    }

    let paragraph = Paragraph::new(lines).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(paragraph, area);
}

fn render_project_select(frame: &mut Frame, area: Rect, app: &App) {
    let filtered = app.filtered_projects();
    let mut lines: Vec<Line<'_>> = Vec::new();

    // Title line with filter display.
    if app.start_project_filter.is_empty() {
        lines.push(Line::from(vec![Span::styled(
            " select project (j/k, Enter, type to filter):",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )]));
    } else {
        lines.push(Line::from(vec![
            Span::styled(
                " select project [",
                Style::default()
                    .fg(colors::PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                app.start_project_filter.clone(),
                Style::default().fg(colors::TEXT),
            ),
            Span::styled(
                "]:",
                Style::default()
                    .fg(colors::PRIMARY)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
    }

    if filtered.is_empty() {
        lines.push(Line::from(vec![Span::styled(
            "  no matches",
            Style::default().fg(colors::TEXT_DIM),
        )]));
    } else {
        for (idx, project) in filtered.iter().enumerate() {
            let is_selected = idx == app.start_project_idx;
            let bg = if is_selected {
                colors::PRIMARY_DIM
            } else {
                colors::SURFACE
            };
            let indicator = if is_selected { "\u{25B6} " } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {indicator}"),
                    Style::default().fg(colors::PRIMARY).bg(bg),
                ),
                Span::styled((*project).clone(), Style::default().fg(colors::TEXT).bg(bg)),
            ]));
        }
    }

    // Scroll so the selected item stays visible within the panel.
    // +1 accounts for the title line at index 0.
    let visible_rows = area.height as usize;
    let selected_line = app.start_project_idx + 1;
    let scroll_offset = if selected_line >= visible_rows {
        (selected_line - visible_rows + 1) as u16
    } else {
        0
    };

    let paragraph = Paragraph::new(lines)
        .style(Style::default().bg(colors::SURFACE))
        .scroll((scroll_offset, 0));
    frame.render_widget(paragraph, area);
}

fn render_text_prompt(frame: &mut Frame, area: Rect, label: &str, value: &str) {
    let cursor = "\u{2588}";

    let lines = vec![
        Line::from(vec![Span::styled(
            format!(" {label}"),
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )]),
        Line::from(vec![
            Span::styled(" > ", Style::default().fg(colors::TEXT_DIM)),
            Span::styled(value.to_string(), Style::default().fg(colors::TEXT)),
            Span::styled(cursor, Style::default().fg(colors::PRIMARY)),
        ]),
        Line::from(""),
        Line::from(vec![Span::styled(
            " Enter: confirm  Esc: cancel",
            Style::default().fg(colors::TEXT_DIM),
        )]),
    ];

    let paragraph = Paragraph::new(lines).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(paragraph, area);
}
