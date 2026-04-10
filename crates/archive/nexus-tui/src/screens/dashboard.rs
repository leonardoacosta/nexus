use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Padding, Paragraph, Row, Scrollbar, ScrollbarOrientation,
    ScrollbarState, Sparkline, Table, Wrap,
};

use crate::app::{App, colors, format_age, session_type_indicator, status_color, status_dot};
use crate::theme::format_duration;

/// Render the session dashboard screen.
pub fn render_dashboard(frame: &mut Frame, area: Rect, app: &mut App) {
    // Layout: title (3), sessions table (remaining), trend sparkline (2), status bar (1).
    let has_trend = !app.session_history.is_empty();
    let trend_height = if has_trend { 2 } else { 0 };

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(trend_height),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_session_table(frame, chunks[1], app);
    if has_trend {
        render_session_trend(frame, chunks[2], app);
    }
    render_status_bar(frame, chunks[3], app);
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
            "  Tab: switch  j/k: navigate  Enter: detail  a: attach  n: new  /: palette  ?: help  q: quit",
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

fn render_session_table(frame: &mut Frame, area: Rect, app: &mut App) {
    let sessions = app.cached_sessions().to_vec();

    if sessions.is_empty() {
        let welcome_lines = vec![
            Line::from(Span::styled(
                "Nexus",
                Style::default()
                    .fg(colors::PRIMARY)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "Monitor Claude Code sessions across all your machines.",
                Style::default().fg(colors::TEXT),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    "  n",
                    Style::default()
                        .fg(colors::SECONDARY)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "  Start a new session",
                    Style::default().fg(colors::TEXT_DIM),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "  ?",
                    Style::default()
                        .fg(colors::SECONDARY)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "  Show all keybindings",
                    Style::default().fg(colors::TEXT_DIM),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "  Tab",
                    Style::default()
                        .fg(colors::SECONDARY)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "  Switch between screens",
                    Style::default().fg(colors::TEXT_DIM),
                ),
            ]),
            Line::from(""),
            Line::from(Span::styled(
                "Waiting for agent data...",
                Style::default().fg(colors::TEXT_DIM),
            )),
        ];
        let msg = Paragraph::new(welcome_lines)
            .wrap(Wrap { trim: true })
            .block(
                Block::default()
                    .border_type(BorderType::Rounded)
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(colors::TEXT_DIM))
                    .padding(Padding::horizontal(1)),
            );
        frame.render_widget(msg, area);
        return;
    }

    // Build a flat list of rows: project group headers + session rows.
    // session_to_flat maps session index → flat row index so TableState
    // (which counts all rows including headers) stays aligned.
    let mut flat: Vec<Row<'_>> = Vec::new();
    let mut current_project: Option<&str> = None;
    let mut session_to_flat: Vec<usize> = Vec::new();

    for row_data in sessions.iter() {
        let project_name = row_data
            .session
            .project
            .as_deref()
            .unwrap_or("(no project)");

        // Emit group header when project changes.
        if current_project != Some(project_name) {
            current_project = Some(project_name);

            let group_count = sessions
                .iter()
                .filter(|r| r.session.project.as_deref().unwrap_or("(no project)") == project_name)
                .count();

            let header_row = Row::new(vec![
                Line::from(Span::styled(
                    format!(" {project_name}  ({group_count})"),
                    Style::default()
                        .fg(colors::SECONDARY)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(""),
                Line::from(""),
                Line::from(""),
                Line::from(""),
            ])
            .style(Style::default().fg(colors::SECONDARY));

            flat.push(header_row);
        }

        // Session data row.
        let status = row_data.session.status;
        let dot = status_dot(status);
        let dot_color = if row_data.disconnected {
            colors::TEXT_DIM
        } else {
            status_color(status)
        };
        let type_ind = session_type_indicator(&row_data.session);
        let branch = row_data.session.branch.as_deref().unwrap_or("-");
        let age = format_age(row_data.session.started_at);
        let cmd = row_data
            .session
            .command
            .as_deref()
            .or(row_data.session.spec.as_deref())
            .unwrap_or("-");

        // When the owning agent is disconnected, dim all cell text.
        let text_fg = if row_data.disconnected {
            colors::TEXT_DIM
        } else {
            colors::TEXT
        };
        let dim_fg = colors::TEXT_DIM;
        let agent_fg = if row_data.disconnected {
            colors::TEXT_DIM
        } else {
            colors::SECONDARY
        };
        let agent_label = if row_data.disconnected {
            format!("{} (disconnected)", row_data.agent_name)
        } else {
            row_data.agent_name.clone()
        };

        // Task 12.2: Show checkbox indicator for multi-selected rows.
        let is_multi_selected = app.selected_sessions.contains(&row_data.session.id);
        let checkbox = if is_multi_selected { "\u{2611}" } else { " " }; // ☑ / space

        let status_cell = Line::from(vec![
            Span::styled(checkbox, Style::default().fg(colors::PRIMARY)),
            Span::styled(format!("{dot} "), Style::default().fg(dot_color)),
            Span::styled(type_ind.to_string(), Style::default().fg(dim_fg)),
        ]);
        let name_cell = Line::from(Span::styled(
            row_data.session.id.chars().take(8).collect::<String>(),
            Style::default().fg(dim_fg),
        ));
        let branch_cell = Line::from(Span::styled(branch, Style::default().fg(text_fg)));
        let uptime_cell = Line::from(Span::styled(age, Style::default().fg(dim_fg)));
        let cmd_cell = Line::from(Span::styled(cmd, Style::default().fg(text_fg)));
        let agent_cell = Line::from(Span::styled(agent_label, Style::default().fg(agent_fg)));

        session_to_flat.push(flat.len());
        flat.push(Row::new(vec![
            status_cell,
            name_cell,
            branch_cell,
            uptime_cell,
            cmd_cell,
            agent_cell,
        ]));
    }

    // Task 5.1/5.2: Inject synthetic "Agent offline" rows for disconnected agents
    // with no sessions, so the user knows the agent is unreachable.
    let offline = app.offline_agents();
    for row_data in &offline {
        let now = chrono::Utc::now();
        let last_seen_str = row_data
            .last_seen
            .map(|ts| {
                let elapsed = now.signed_duration_since(ts);
                let secs = elapsed.num_seconds().unsigned_abs();
                format!("last seen {}ago", format_duration(secs))
            })
            .unwrap_or_else(|| "never seen".to_string());

        let offline_row = Row::new(vec![
            Line::from(Span::styled(
                " \u{2716} ",
                Style::default()
                    .fg(colors::ERROR)
                    .add_modifier(Modifier::DIM),
            )),
            Line::from(Span::styled(
                "offline",
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            )),
            Line::from(Span::styled(
                last_seen_str,
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            )),
            Line::from(""),
            Line::from(Span::styled(
                row_data
                    .error
                    .as_deref()
                    .map(|e| format!("Agent offline — {e}"))
                    .unwrap_or_else(|| "Agent offline — unreachable".to_string()),
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            )),
            Line::from(Span::styled(
                row_data.agent_name.clone(),
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            )),
        ])
        .style(Style::default().add_modifier(Modifier::DIM));
        flat.push(offline_row);
    }

    // Compute the flat index for the currently selected session and update
    // TableState so ratatui highlights the right row.
    let selected_session_idx = app.selected_index.min(sessions.len().saturating_sub(1));
    let selected_flat_idx = session_to_flat
        .get(selected_session_idx)
        .copied()
        .unwrap_or(0);
    app.dashboard_table_state.select(Some(selected_flat_idx));

    let total_rows = flat.len();
    let rows: Vec<Row<'_>> = flat;

    let header = Row::new(vec![
        Line::from(Span::styled(
            " STATUS",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "ID",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "BRANCH",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "UPTIME",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "COMMAND",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "AGENT",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
    ])
    .style(
        Style::default()
            .fg(colors::TEXT_DIM)
            .add_modifier(Modifier::BOLD),
    )
    .height(1);

    let widths = [
        Constraint::Length(8),  // status dot + type indicator
        Constraint::Length(10), // session id (8 chars)
        Constraint::Length(18), // branch
        Constraint::Length(10), // uptime
        Constraint::Fill(1),    // command (fills remaining)
        Constraint::Length(14), // agent name
    ];

    let table = Table::new(rows, widths)
        .header(header)
        .column_spacing(1)
        .row_highlight_style(
            Style::default()
                .bg(colors::PRIMARY_DIM)
                .add_modifier(Modifier::BOLD),
        )
        .block(
            Block::default()
                .border_type(BorderType::Rounded)
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors::TEXT_DIM))
                .padding(Padding::horizontal(1)),
        );

    // Reserve 1 column on the right for the scrollbar.
    let table_area = Rect {
        width: area.width.saturating_sub(1),
        ..area
    };
    let scrollbar_area = Rect {
        x: area.x + area.width.saturating_sub(1),
        width: 1,
        ..area
    };

    frame.render_stateful_widget(table, table_area, &mut app.dashboard_table_state);

    // Scrollbar.
    let mut scrollbar_state = ScrollbarState::new(total_rows).position(selected_flat_idx);
    let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight);
    frame.render_stateful_widget(scrollbar, scrollbar_area, &mut scrollbar_state);
}

fn render_session_trend(frame: &mut Frame, area: Rect, app: &App) {
    let session_data: Vec<u64> = app
        .session_history
        .iter()
        .map(|e| e.session_count as u64)
        .collect();
    let sparkline = Sparkline::default()
        .data(&session_data)
        .style(Style::default().fg(colors::SECONDARY))
        .block(
            Block::default()
                .title(Span::styled(
                    " Sessions/day ",
                    Style::default().fg(colors::TEXT_DIM),
                ))
                .borders(Borders::NONE),
        );
    frame.render_widget(sparkline, area);
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
            spans.push(Span::styled(
                "\u{25CF} ",
                Style::default().fg(colors::PRIMARY),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else if let Some(attempt) = agent.reconnect_attempt {
            spans.push(Span::styled(
                format!("\u{21BB}({attempt}) "),
                Style::default().fg(colors::WARNING),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else if agent.dns_failure {
            spans.push(Span::styled(
                "\u{2716} DNS ",
                Style::default().fg(colors::ERROR),
            ));
            spans.push(Span::styled(
                agent.info.name.clone(),
                Style::default().fg(colors::TEXT_DIM),
            ));
        } else {
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

    // Task 6.2: Show "Updated Xs ago" freshness indicator; dim/yellow when stale > 30s.
    if let Some(last_updated) = app.last_data_updated {
        let secs = last_updated.elapsed().as_secs();
        let freshness_str = format!(" \u{00B7} updated {}ago", format_duration(secs));
        let freshness_style = if secs > 30 {
            Style::default()
                .fg(ratatui::style::Color::Yellow)
                .add_modifier(Modifier::DIM)
        } else {
            Style::default().fg(colors::TEXT_DIM)
        };
        spans.push(Span::styled(freshness_str, freshness_style));
    }

    // Show pending spec count if any.
    if app.pending_spec_count > 0 {
        spans.push(Span::styled(
            format!(" \u{00B7} {} specs pending", app.pending_spec_count),
            Style::default().fg(colors::WARNING),
        ));
    }

    // Show recent failure count badge.
    let total_failures: i32 = app.failure_trends_daily.iter().map(|e| e.count).sum();
    if total_failures > 0 {
        let fail_color = if total_failures > 10 {
            colors::ERROR
        } else {
            colors::WARNING
        };
        spans.push(Span::styled(
            format!(" \u{00B7} \u{25B2} {total_failures} failures"),
            Style::default().fg(fail_color),
        ));
    }

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

#[cfg(test)]
mod tests {
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;

    use crate::app::App;

    use super::render_dashboard;

    #[test]
    fn renders_without_panic_on_empty_data() {
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut app = App::new();
        terminal
            .draw(|f| {
                render_dashboard(f, f.area(), &mut app);
            })
            .unwrap();
    }

    #[test]
    fn renders_without_panic_with_no_agents() {
        let backend = TestBackend::new(120, 40);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut app = App::new();
        app.agents.clear();
        terminal
            .draw(|f| {
                render_dashboard(f, f.area(), &mut app);
            })
            .unwrap();
    }

    #[test]
    fn renders_without_panic_small_terminal() {
        // Stress the layout with a very small area.
        let backend = TestBackend::new(10, 5);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut app = App::new();
        terminal
            .draw(|f| {
                render_dashboard(f, f.area(), &mut app);
            })
            .unwrap();
    }
}
