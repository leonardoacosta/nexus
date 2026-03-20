use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::app::{App, InputMode, colors};

/// Render the command palette overlay.
///
/// The palette is drawn as a centered floating panel: input line at top,
/// filtered results below.
pub fn render_palette(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Center the palette: 60% width, up to 20 rows tall.
    let palette_width = (area.width * 60 / 100).max(40).min(area.width);
    let palette_height = 20u16.min(area.height.saturating_sub(4));
    let x = (area.width.saturating_sub(palette_width)) / 2;
    let y = (area.height.saturating_sub(palette_height)) / 2;
    let palette_area = Rect::new(x, y, palette_width, palette_height);

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

            Line::from(vec![
                Span::styled(
                    format!(" {indicator}"),
                    Style::default().fg(colors::PRIMARY).bg(bg),
                ),
                Span::styled(
                    entry.label.clone(),
                    Style::default().fg(colors::TEXT).bg(bg),
                ),
            ])
        })
        .collect();

    let paragraph = Paragraph::new(lines).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(paragraph, area);
}

/// Render the start-session wizard overlay (agent select / project input / cwd input).
pub fn render_start_session(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let panel_width = (area.width * 50 / 100).max(30).min(area.width);
    let panel_height = 12u16.min(area.height.saturating_sub(4));
    let x = (area.width.saturating_sub(panel_width)) / 2;
    let y = (area.height.saturating_sub(panel_height)) / 2;
    let panel_area = Rect::new(x, y, panel_width, panel_height);

    match app.input_mode {
        InputMode::StartSessionAgent => render_agent_select(frame, panel_area, app),
        InputMode::StartSessionProject => {
            render_text_prompt(frame, panel_area, "project:", &app.start_project)
        }
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
