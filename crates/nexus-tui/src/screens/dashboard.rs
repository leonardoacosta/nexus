use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Padding, Paragraph, Row, Scrollbar, ScrollbarOrientation,
    ScrollbarState, Table,
};

use crate::app::{
    App, colors, format_age, session_type_indicator, status_color, status_dot,
};

/// Render the session dashboard screen.
pub fn render_dashboard(frame: &mut Frame, area: Rect, app: &mut App) {

    // Layout: title (3), sessions table (remaining - 1), status bar (1).
    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_session_table(frame, chunks[1], app);
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
            "  Tab: switch  j/k: navigate  Enter: detail  q: quit",
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
    let sessions = app.all_sessions();

    if sessions.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "No sessions. Waiting for agent data...",
            Style::default().fg(colors::TEXT_DIM),
        )]))
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
        let project_name = row_data.session.project.as_deref().unwrap_or("(no project)");

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
        let dot_color = status_color(status);
        let type_ind = session_type_indicator(&row_data.session);
        let branch = row_data.session.branch.as_deref().unwrap_or("-");
        let age = format_age(row_data.session.started_at);
        let cmd = row_data
            .session
            .command
            .as_deref()
            .or(row_data.session.spec.as_deref())
            .unwrap_or("-");

        let status_cell = Line::from(vec![
            Span::styled(format!(" {dot} "), Style::default().fg(dot_color)),
            Span::styled(format!("{type_ind}"), Style::default().fg(colors::TEXT_DIM)),
        ]);
        let name_cell = Line::from(Span::styled(
            row_data.session.id.chars().take(8).collect::<String>(),
            Style::default().fg(colors::TEXT_DIM),
        ));
        let branch_cell = Line::from(Span::styled(branch, Style::default().fg(colors::TEXT)));
        let uptime_cell = Line::from(Span::styled(age, Style::default().fg(colors::TEXT_DIM)));
        let cmd_cell = Line::from(Span::styled(cmd, Style::default().fg(colors::TEXT)));
        let agent_cell = Line::from(Span::styled(
            row_data.agent_name.clone(),
            Style::default().fg(colors::SECONDARY),
        ));

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
            " ST",
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
        Constraint::Length(5),  // status dot + type indicator
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

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}
