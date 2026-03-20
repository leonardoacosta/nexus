use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Row, Table};

use crate::app::{App, colors};

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
            "  Tab: switch  j/k: navigate  q: quit",
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
        "PROJECT", "TOTAL", "ACTIVE", "IDLE", "STALE", "ERROR", "AGENTS",
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

            Row::new(vec![
                p.name.clone(),
                p.total.to_string(),
                p.active.to_string(),
                p.idle.to_string(),
                p.stale.to_string(),
                p.errored.to_string(),
                agents_str,
            ])
            .style(Style::default().fg(colors::TEXT).bg(bg))
        })
        .collect();

    let widths = [
        Constraint::Length(16),
        Constraint::Length(6),
        Constraint::Length(7),
        Constraint::Length(6),
        Constraint::Length(6),
        Constraint::Length(6),
        Constraint::Fill(1),
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
