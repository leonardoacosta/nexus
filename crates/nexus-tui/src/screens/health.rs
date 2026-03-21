use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, colors, format_age, format_duration};

/// Render the health overview screen.
pub fn render_health(frame: &mut Frame, app: &App) {
    let area = frame.area();

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_agent_cards(frame, chunks[1], app);
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

fn render_agent_cards(frame: &mut Frame, area: Rect, app: &App) {
    if app.agents.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "No agents configured.",
            Style::default().fg(colors::TEXT_DIM),
        )]));
        frame.render_widget(msg, area);
        return;
    }

    let mut lines: Vec<Line<'_>> = Vec::new();

    for (idx, agent) in app.agents.iter().enumerate() {
        let is_selected = idx == app.selected_index;
        let bg = if is_selected {
            colors::PRIMARY_DIM
        } else {
            colors::BG
        };

        // Agent header line.
        let (status_indicator, status_color) = if agent.connected {
            ("\u{25CF}", colors::PRIMARY) // ● green
        } else {
            ("\u{2716}", colors::ERROR) // ✖ red
        };

        let mut header_spans = vec![
            Span::styled(
                format!(" {status_indicator} "),
                Style::default().fg(status_color).bg(bg),
            ),
            Span::styled(
                agent.info.name.clone(),
                Style::default()
                    .fg(colors::SECONDARY)
                    .bg(bg)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  ({}:{})", agent.info.host, agent.info.port),
                Style::default().fg(colors::TEXT_DIM).bg(bg),
            ),
        ];

        if !agent.connected {
            let last_seen_str = agent
                .last_seen
                .map(format_age)
                .unwrap_or_else(|| "never".to_string());
            header_spans.push(Span::styled(
                format!("  last seen {last_seen_str}"),
                Style::default().fg(colors::ERROR).bg(bg),
            ));
            if let Some(err) = &agent.last_error {
                header_spans.push(Span::styled(
                    format!("  ({err})"),
                    Style::default().fg(colors::TEXT_DIM).bg(bg),
                ));
            }
        }

        lines.push(Line::from(header_spans));

        // Metrics (if available).
        if let Some(health) = &agent.info.health {
            let cpu_line = Line::from(vec![
                Span::styled("   cpu: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                Span::styled(
                    format!("{:.1}%", health.cpu_percent),
                    Style::default().fg(cpu_color(health.cpu_percent)).bg(bg),
                ),
                Span::styled("  ram: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                Span::styled(
                    format!(
                        "{:.1}/{:.1} GB",
                        health.memory_used_gb, health.memory_total_gb
                    ),
                    Style::default().fg(colors::TEXT).bg(bg),
                ),
                Span::styled("  disk: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                Span::styled(
                    format!("{:.1}/{:.1} GB", health.disk_used_gb, health.disk_total_gb),
                    Style::default().fg(colors::TEXT).bg(bg),
                ),
            ]);
            lines.push(cpu_line);

            let load_line = Line::from(vec![
                Span::styled("   load: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                Span::styled(
                    format!(
                        "{:.2} {:.2} {:.2}",
                        health.load_avg[0], health.load_avg[1], health.load_avg[2]
                    ),
                    Style::default().fg(colors::TEXT).bg(bg),
                ),
                Span::styled("  uptime: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                Span::styled(
                    format_duration(health.uptime_seconds),
                    Style::default().fg(colors::TEXT).bg(bg),
                ),
            ]);
            lines.push(load_line);

            // Docker containers.
            if let Some(containers) = &health.docker_containers {
                let running = containers.iter().filter(|c| c.running).count();
                let stopped = containers.len() - running;
                let docker_line = Line::from(vec![
                    Span::styled("   docker: ", Style::default().fg(colors::TEXT_DIM).bg(bg)),
                    Span::styled(
                        format!("{running} running"),
                        Style::default().fg(colors::PRIMARY).bg(bg),
                    ),
                    Span::styled(
                        format!(", {stopped} stopped"),
                        Style::default().fg(colors::TEXT_DIM).bg(bg),
                    ),
                ]);
                lines.push(docker_line);
            }
        } else if agent.connected {
            lines.push(Line::from(vec![Span::styled(
                "   (health data not available)",
                Style::default().fg(colors::TEXT_DIM).bg(bg),
            )]));
        }

        // Separator between agents.
        lines.push(Line::from(""));
    }

    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let mut spans: Vec<Span> = vec![Span::raw(" ")];

    for (i, agent) in app.agents.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" ", Style::default().fg(colors::TEXT_DIM)));
        }
        let dot_color = if agent.connected {
            colors::PRIMARY
        } else {
            colors::ERROR
        };
        spans.push(Span::styled("\u{25CF} ", Style::default().fg(dot_color)));
        spans.push(Span::styled(
            agent.info.name.clone(),
            Style::default().fg(colors::TEXT_DIM),
        ));
    }

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(bar, area);
}

/// Choose color based on CPU utilization level.
fn cpu_color(percent: f32) -> ratatui::style::Color {
    if percent > 90.0 {
        colors::ERROR
    } else if percent > 70.0 {
        colors::WARNING
    } else {
        colors::PRIMARY
    }
}
