use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{
    App, colors, format_age, session_type_indicator, status_color, status_dot, status_sparkline,
};

/// Render the session dashboard screen.
pub fn render_dashboard(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Layout: title (1), sessions list (remaining - 1), status bar (1).
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_session_list(frame, chunks[1], app);
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

fn render_session_list(frame: &mut Frame, area: Rect, app: &App) {
    let sessions = app.all_sessions();

    if sessions.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "No sessions. Waiting for agent data...",
            Style::default().fg(colors::TEXT_DIM),
        )]))
        .block(Block::default());
        frame.render_widget(msg, area);
        return;
    }

    // Group sessions by project for rendering with group headers.
    let mut lines: Vec<(Line<'_>, bool)> = Vec::new(); // (line, is_selectable)
    let mut current_project: Option<&str> = None;
    let mut selectable_idx: usize = 0;

    for (flat_idx, row) in sessions.iter().enumerate() {
        let project_name = row.session.project.as_deref().unwrap_or("(no project)");

        // Emit group header when project changes.
        if current_project != Some(project_name) {
            current_project = Some(project_name);

            // Count sessions in this project group.
            let group_count = sessions
                .iter()
                .filter(|r| r.session.project.as_deref().unwrap_or("(no project)") == project_name)
                .count();

            let header = Line::from(vec![
                Span::styled(
                    format!(" {project_name}"),
                    Style::default()
                        .fg(colors::SECONDARY)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  ({group_count})"),
                    Style::default().fg(colors::TEXT_DIM),
                ),
            ]);
            lines.push((header, false));
        }

        // Session row.
        let status = row.session.status;
        let dot = status_dot(status);
        let dot_color = status_color(status);
        let type_ind = session_type_indicator(&row.session);
        let branch = row.session.branch.as_deref().unwrap_or("-");
        let age = format_age(row.session.started_at);
        let cmd = row
            .session
            .command
            .as_deref()
            .or(row.session.spec.as_deref())
            .unwrap_or("-");
        let sparkline = status_sparkline(status);

        let is_selected = flat_idx == app.selected_index;
        let bg = if is_selected {
            colors::PRIMARY_DIM
        } else {
            colors::BG
        };

        let line = Line::from(vec![
            Span::styled(format!("  {dot} "), Style::default().fg(dot_color).bg(bg)),
            Span::styled(
                format!("{type_ind} "),
                Style::default().fg(colors::TEXT_DIM).bg(bg),
            ),
            Span::styled(
                format!("{branch:<16} "),
                Style::default().fg(colors::TEXT).bg(bg),
            ),
            Span::styled(
                format!("{age:<10} "),
                Style::default().fg(colors::TEXT_DIM).bg(bg),
            ),
            Span::styled(
                format!("{cmd:<30} "),
                Style::default().fg(colors::TEXT).bg(bg),
            ),
            Span::styled(
                format!("{sparkline} "),
                Style::default().fg(colors::PRIMARY_BRIGHT).bg(bg),
            ),
            Span::styled(
                row.agent_name.clone(),
                Style::default().fg(colors::SECONDARY).bg(bg),
            ),
        ]);
        lines.push((line, true));
        selectable_idx += 1;
    }

    // Determine visible window: scroll so selected row is visible.
    let visible_height = area.height as usize;
    // Find the line index corresponding to the selected session.
    let mut selected_line_idx = 0;
    let mut seen_selectable = 0;
    for (i, (_, selectable)) in lines.iter().enumerate() {
        if *selectable {
            if seen_selectable == app.selected_index {
                selected_line_idx = i;
                break;
            }
            seen_selectable += 1;
        }
    }

    let scroll_offset = if selected_line_idx >= visible_height {
        // Keep selected row near bottom.
        selected_line_idx.saturating_sub(visible_height / 2)
    } else {
        0
    };

    let visible_lines: Vec<Line<'_>> = lines
        .into_iter()
        .skip(scroll_offset)
        .take(visible_height)
        .map(|(line, _)| line)
        .collect();

    let _ = selectable_idx; // suppress unused variable
    let paragraph = Paragraph::new(visible_lines);
    frame.render_widget(paragraph, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sessions = app.session_count();
    let uptime = app.uptime_string();

    let mut spans: Vec<Span> = vec![Span::raw(" ")];

    for (i, agent) in app.agents.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" ", Style::default().fg(colors::TEXT_DIM)));
        }

        if agent.connected {
            // Green dot for connected agents.
            spans.push(Span::styled(
                "\u{25CF} ",
                Style::default().fg(colors::PRIMARY),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else if let Some(attempt) = agent.reconnect_attempt {
            // Amber reconnecting indicator with attempt count.
            spans.push(Span::styled(
                format!("\u{21BB}({attempt}) "), // ↻
                Style::default().fg(colors::WARNING),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else if agent.dns_failure {
            // Red for permanent DNS failures.
            spans.push(Span::styled(
                "\u{2716} DNS ",
                Style::default().fg(colors::ERROR),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else {
            // Red dot for other disconnected states.
            spans.push(Span::styled(
                "\u{2716} ",
                Style::default().fg(colors::ERROR),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }
    }

    spans.push(Span::styled(
        format!(" \u{00B7} {sessions} sessions \u{00B7} \u{2191}{uptime}"),
        Style::default().fg(colors::TEXT_DIM),
    ));

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}
