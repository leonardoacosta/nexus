use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Padding, Paragraph, Wrap};

use crate::app::{App, colors, format_age, session_type_indicator, status_color, status_dot};

/// Render the session detail screen.
pub fn render_detail(frame: &mut Frame, area: Rect, app: &App) {

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0]);
    render_detail_body(frame, chunks[1], app);
    render_footer(frame, chunks[2]);
}

fn render_title_bar(frame: &mut Frame, area: Rect) {
    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            "SESSION DETAIL",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "  q/Esc: back  a: stream  s: stop",
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

fn render_detail_body(frame: &mut Frame, area: Rect, app: &App) {
    let (session, agent) = match &app.selected_session {
        Some(pair) => pair,
        None => {
            let msg = Paragraph::new(Line::from(vec![Span::styled(
                "No session selected.",
                Style::default().fg(colors::TEXT_DIM),
            )]));
            frame.render_widget(msg, area);
            return;
        }
    };

    // 2-panel horizontal layout: left 50% metadata, right 50% status info.
    let panels = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(area);

    render_metadata_panel(frame, panels[0], session, agent);
    render_status_panel(frame, panels[1], session, agent, app);
}

fn render_metadata_panel(
    frame: &mut Frame,
    area: Rect,
    session: &nexus_core::session::Session,
    _agent: &nexus_core::agent::AgentInfo,
) {
    let label_style = Style::default().fg(colors::TEXT_DIM);
    let value_style = Style::default().fg(colors::TEXT);

    let short_id: String = session.id.chars().take(8).collect();
    let type_ind = session_type_indicator(session);
    let age = format_age(session.started_at);
    let started = session
        .started_at
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();
    let last_hb = session
        .last_heartbeat
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();

    let fields: Vec<(&str, Line<'_>)> = vec![
        (
            "id",
            Line::from(Span::styled(short_id, value_style)),
        ),
        (
            "project",
            Line::from(Span::styled(
                session.project.as_deref().unwrap_or("-").to_string(),
                value_style,
            )),
        ),
        (
            "branch",
            Line::from(Span::styled(
                session.branch.as_deref().unwrap_or("-").to_string(),
                value_style,
            )),
        ),
        (
            "cwd",
            Line::from(Span::styled(session.cwd.clone(), value_style)),
        ),
        (
            "type",
            Line::from(Span::styled(type_ind.to_string(), value_style)),
        ),
        (
            "started_at",
            Line::from(Span::styled(started, value_style)),
        ),
        (
            "last_heartbeat",
            Line::from(Span::styled(last_hb, value_style)),
        ),
        (
            "uptime",
            Line::from(Span::styled(age, value_style)),
        ),
    ];

    render_card(frame, area, "METADATA", &fields, label_style);
}

fn render_status_panel(
    frame: &mut Frame,
    area: Rect,
    session: &nexus_core::session::Session,
    agent: &nexus_core::agent::AgentInfo,
    app: &App,
) {
    let label_style = Style::default().fg(colors::TEXT_DIM);
    let value_style = Style::default().fg(colors::TEXT);

    let status = session.status;
    let dot = status_dot(status);
    let dot_color = status_color(status);

    // Connection status derived from the agent's connected flag in app state.
    let conn_status = app
        .agents
        .iter()
        .find(|a| a.info.name == agent.name)
        .map(|a| {
            if a.connected {
                "connected"
            } else if a.reconnect_attempt.is_some() {
                "reconnecting"
            } else if a.dns_failure {
                "dns failure"
            } else {
                "disconnected"
            }
        })
        .unwrap_or("unknown");

    let conn_color = if conn_status == "connected" {
        colors::PRIMARY
    } else if conn_status == "reconnecting" {
        colors::WARNING
    } else {
        colors::ERROR
    };

    let fields: Vec<(&str, Line<'_>)> = vec![
        (
            "status",
            Line::from(vec![
                Span::styled(format!("{dot} "), Style::default().fg(dot_color)),
                Span::styled(format!("{status:?}"), Style::default().fg(dot_color)),
            ]),
        ),
        (
            "agent",
            Line::from(Span::styled(agent.name.clone(), value_style)),
        ),
        (
            "agent_host",
            Line::from(Span::styled(agent.host.clone(), value_style)),
        ),
        (
            "connection",
            Line::from(Span::styled(conn_status.to_string(), Style::default().fg(conn_color))),
        ),
    ];

    render_card(frame, area, "STATUS", &fields, label_style);
}

/// Render a labeled card with rounded borders and key-value rows.
fn render_card(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    fields: &[(&str, Line<'_>)],
    label_style: Style,
) {
    let label_width: usize = 14;

    let mut lines: Vec<Line<'_>> = Vec::new();

    for (label, value_line) in fields {
        let mut spans = vec![Span::styled(
            format!("{:<width$}  ", label, width = label_width),
            label_style,
        )];
        spans.extend(value_line.spans.iter().cloned());
        lines.push(Line::from(spans));
    }

    let block = Block::default()
        .title(format!(" {title} "))
        .title_style(
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        )
        .border_type(BorderType::Rounded)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(colors::TEXT_DIM))
        .padding(Padding::horizontal(1));

    let paragraph = Paragraph::new(lines)
        .block(block)
        .wrap(Wrap { trim: true });
    frame.render_widget(paragraph, area);
}

fn render_footer(frame: &mut Frame, area: Rect) {
    let bar = Paragraph::new(Line::from(vec![Span::styled(
        " q: back  a: stream attach  s: stop session",
        Style::default().fg(colors::TEXT_DIM),
    )]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

