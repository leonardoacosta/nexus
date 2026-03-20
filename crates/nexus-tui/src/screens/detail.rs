use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, colors, format_age, session_type_indicator, status_color, status_dot};

/// Render the session detail screen.
pub fn render_detail(frame: &mut Frame, app: &App) {
    let area = frame.area();

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
        Span::styled("  q/Esc: back", Style::default().fg(colors::TEXT_DIM)),
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

    let label_style = Style::default().fg(colors::TEXT_DIM);
    let value_style = Style::default().fg(colors::TEXT);

    let status = session.status;
    let dot = status_dot(status);
    let dot_color = status_color(status);
    let type_ind = session_type_indicator(session);
    let age = format_age(session.started_at);
    let started = session
        .started_at
        .format("%Y-%m-%d %H:%M:%S UTC")
        .to_string();

    // Build key-value rows.
    let fields: Vec<(&str, Line<'_>)> = vec![
        (
            "id",
            Line::from(Span::styled(session.id.clone(), value_style)),
        ),
        (
            "pid",
            Line::from(Span::styled(session.pid.to_string(), value_style)),
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
        ("started_at", Line::from(Span::styled(started, value_style))),
        ("age", Line::from(Span::styled(age, value_style))),
        (
            "status",
            Line::from(vec![
                Span::styled(format!("{dot} "), Style::default().fg(dot_color)),
                Span::styled(format!("{status:?}"), Style::default().fg(dot_color)),
            ]),
        ),
        (
            "spec",
            Line::from(Span::styled(
                session.spec.as_deref().unwrap_or("-").to_string(),
                value_style,
            )),
        ),
        (
            "command",
            Line::from(Span::styled(
                session.command.as_deref().unwrap_or("-").to_string(),
                value_style,
            )),
        ),
        (
            "agent",
            Line::from(Span::styled(agent.name.clone(), value_style)),
        ),
        (
            "type",
            Line::from(Span::styled(type_ind.to_string(), value_style)),
        ),
        (
            "tmux_session",
            Line::from(Span::styled(
                session.tmux_session.as_deref().unwrap_or("-").to_string(),
                value_style,
            )),
        ),
    ];

    // Render as box-drawn bordered card.
    let label_width: u16 = 14;
    let inner = shrink(area, 1, 1);

    // Top border.
    let border_top = format!(
        " \u{250C}{}\u{2510}",
        "\u{2500}".repeat((inner.width.saturating_sub(2)) as usize)
    );
    // Bottom border.
    let border_bot = format!(
        " \u{2514}{}\u{2518}",
        "\u{2500}".repeat((inner.width.saturating_sub(2)) as usize)
    );

    let mut lines: Vec<Line<'_>> = Vec::new();
    lines.push(Line::from(Span::styled(
        border_top,
        Style::default().fg(colors::TEXT_DIM),
    )));

    for (label, value_line) in &fields {
        let mut spans = vec![
            Span::styled(" \u{2502} ", Style::default().fg(colors::TEXT_DIM)),
            Span::styled(
                format!("{:<width$}", label, width = label_width as usize),
                label_style,
            ),
        ];
        spans.extend(value_line.spans.iter().cloned());
        lines.push(Line::from(spans));
    }

    lines.push(Line::from(Span::styled(
        border_bot,
        Style::default().fg(colors::TEXT_DIM),
    )));

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, area);
}

fn render_footer(frame: &mut Frame, area: Rect) {
    let bar = Paragraph::new(Line::from(vec![Span::styled(
        " q: back  s: stop session",
        Style::default().fg(colors::TEXT_DIM),
    )]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

/// Shrink a Rect by the given horizontal and vertical margins.
fn shrink(area: Rect, h: u16, v: u16) -> Rect {
    Rect {
        x: area.x + h,
        y: area.y + v,
        width: area.width.saturating_sub(h * 2),
        height: area.height.saturating_sub(v * 2),
    }
}
