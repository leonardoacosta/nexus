use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Row, Table, Wrap};

use crate::app::{App, colors, format_age};

/// Render the project overview screen.
pub fn render_projects(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_project_table(frame, chunks[1], app);
    render_status_bar(frame, chunks[2], app);
}

fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            app.current_screen.title(),
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "  Tab: switch  j/k: navigate  e: notes  q: quit",
            Style::default().fg(colors::TEXT_DIM),
        ),
    ]))
    .block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, area);
}

fn render_project_table(frame: &mut Frame, area: Rect, app: &App) {
    let summaries = app.project_summaries();

    if summaries.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "No projects found.",
            Style::default().fg(colors::TEXT_DIM),
        )]));
        frame.render_widget(msg, area);
        return;
    }

    // Table header.
    let header = Row::new(vec![
        "",
        "PROJECT",
        "SESSIONS",
        "ACTIVE",
        "IDLE",
        "STALE",
        "ERROR",
        "LAST ACTIVITY",
        "AGENTS",
    ])
    .style(
        Style::default()
            .fg(colors::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    );

    let rows: Vec<Row<'_>> = summaries
        .iter()
        .enumerate()
        .map(|(idx, p)| {
            let is_selected = idx == app.selected_index;
            let bg = if is_selected {
                colors::PRIMARY_DIM
            } else {
                colors::BG
            };

            let agents_str = p.agents.join(", ");
            let last_activity_str = match p.last_activity {
                Some(dt) => format_age(dt),
                None => "-".to_string(),
            };

            // Note indicator: [N] if this project has notes.
            let has_note = app.project_notes.get(&p.name).is_some();
            let name_display = if has_note {
                format!("{} [N]", p.name)
            } else {
                p.name.clone()
            };

            // Status dot with color.
            let dot_span = Span::styled(
                p.activity_status.dot(),
                Style::default().fg(p.activity_status.color()),
            );

            Row::new(vec![
                Line::from(dot_span),
                Line::from(name_display),
                Line::from(p.total.to_string()),
                Line::from(p.active.to_string()),
                Line::from(p.idle.to_string()),
                Line::from(p.stale.to_string()),
                Line::from(p.errored.to_string()),
                Line::from(last_activity_str),
                Line::from(agents_str),
            ])
            .style(Style::default().fg(colors::TEXT).bg(bg))
        })
        .collect();

    let widths = [
        Constraint::Length(2),  // dot
        Constraint::Length(20), // project name + [N]
        Constraint::Length(9),  // sessions
        Constraint::Length(7),  // active
        Constraint::Length(6),  // idle
        Constraint::Length(6),  // stale
        Constraint::Length(6),  // error
        Constraint::Length(14), // last activity
        Constraint::Fill(1),    // agents
    ];

    let table = Table::new(rows, widths).header(header).column_spacing(1);

    frame.render_widget(table, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let summaries = app.project_summaries();
    let total_projects = summaries.len();
    let total_sessions: usize = summaries.iter().map(|p| p.total).sum();

    let bar = Paragraph::new(Line::from(vec![Span::styled(
        format!(" {total_projects} projects \u{00B7} {total_sessions} sessions"),
        Style::default().fg(colors::TEXT_DIM),
    )]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

/// Render the scratchpad overlay (centered bordered panel with note text and cursor).
pub fn render_scratchpad(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Center the overlay: 60% width, 50% height.
    let overlay_area = area.centered(Constraint::Percentage(60), Constraint::Percentage(50));

    // Clear the area behind the overlay.
    frame.render_widget(Clear, overlay_area);

    let project_name = app.scratchpad_project.as_deref().unwrap_or("(no project)");

    let title = format!(" Notes: {project_name} ");

    // Build the text with a cursor indicator.
    let display_text = format!("{}\u{2588}", app.scratchpad_text); // block cursor at end

    let paragraph = Paragraph::new(display_text)
        .style(Style::default().fg(colors::TEXT).bg(colors::SURFACE))
        .block(
            Block::default()
                .title(title)
                .title_style(
                    Style::default()
                        .fg(colors::PRIMARY)
                        .add_modifier(Modifier::BOLD),
                )
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors::PRIMARY)),
        )
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, overlay_area);

    // Render hint at the bottom of the overlay.
    let hint_area = Rect {
        x: overlay_area.x + 1,
        y: overlay_area.y + overlay_area.height.saturating_sub(1),
        width: overlay_area.width.saturating_sub(2),
        height: 1,
    };
    let hint = Paragraph::new(Line::from(vec![Span::styled(
        " Esc: save & close  Enter: newline ",
        Style::default().fg(colors::TEXT_DIM).bg(colors::SURFACE),
    )]));
    frame.render_widget(hint, hint_area);
}
