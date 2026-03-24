use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, LineGauge, Padding, Paragraph, Sparkline, Wrap,
};

use crate::app::{App, colors, format_age, format_duration};

/// Render the health overview screen.
pub fn render_health(frame: &mut Frame, area: Rect, app: &App) {
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
        )]))
        .block(
            Block::default()
                .border_type(BorderType::Rounded)
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors::TEXT_DIM))
                .padding(Padding::horizontal(1)),
        )
        .wrap(Wrap { trim: true });
        frame.render_widget(msg, area);
        return;
    }

    // Split the area into per-agent cards of fixed height (13 rows each).
    // If fewer agents fit, show what we can.
    let card_height: u16 = 13;
    let n = app.agents.len();
    let constraints: Vec<Constraint> = (0..n)
        .map(|_| Constraint::Length(card_height))
        .chain(std::iter::once(Constraint::Min(0)))
        .collect();
    let card_areas = Layout::vertical(constraints).split(area);

    for (idx, agent) in app.agents.iter().enumerate() {
        if idx >= card_areas.len().saturating_sub(1) {
            break;
        }
        render_agent_card(frame, card_areas[idx], app, agent, idx);
    }
}

fn render_agent_card(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    agent: &crate::app::AgentData,
    idx: usize,
) {
    let is_selected = idx == app.selected_index;

    let (status_indicator, status_color) = if agent.connected {
        ("\u{25CF}", colors::PRIMARY) // ●
    } else {
        ("\u{2716}", colors::ERROR) // ✖
    };

    let border_color = if is_selected {
        colors::PRIMARY
    } else {
        colors::TEXT_DIM
    };

    // Build the card title with connection info.
    let title_text = format!(
        " {status_indicator} {}  ({}:{}) ",
        agent.info.name, agent.info.host, agent.info.port
    );

    let card_block = Block::default()
        .border_type(BorderType::Rounded)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border_color))
        .title(Span::styled(
            title_text,
            Style::default()
                .fg(status_color)
                .add_modifier(Modifier::BOLD),
        ))
        .padding(Padding::horizontal(1));

    // Inner area after block border + padding.
    let inner = card_block.inner(area);
    frame.render_widget(card_block, area);

    if !agent.connected {
        let mut spans = vec![Span::styled(
            "disconnected",
            Style::default().fg(colors::ERROR),
        )];
        if let Some(last_seen) = agent.last_seen {
            spans.push(Span::styled(
                format!("  last seen {}", format_age(last_seen)),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }
        if let Some(err) = &agent.last_error {
            spans.push(Span::styled(
                format!("  ({err})"),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }
        let msg = Paragraph::new(Line::from(spans));
        frame.render_widget(msg, inner);
        return;
    }

    let Some(health) = &agent.info.health else {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "(health data not available)",
            Style::default().fg(colors::TEXT_DIM),
        )]));
        frame.render_widget(msg, inner);
        return;
    };

    // Layout inside the card:
    //  Row 0: CPU label + gauge (1 row)
    //  Row 1: CPU sparkline (2 rows)
    //  Row 2: RAM label + gauge (1 row)
    //  Row 3: RAM sparkline (2 rows)
    //  Row 4: Disk label + gauge (1 row)
    //  Row 5: Load / uptime (1 row)
    //  Row 6: Docker (1 row, optional)
    let row_constraints = [
        Constraint::Length(1), // cpu gauge
        Constraint::Length(2), // cpu sparkline
        Constraint::Length(1), // ram gauge
        Constraint::Length(2), // ram sparkline
        Constraint::Length(1), // disk gauge
        Constraint::Length(1), // load / uptime
        Constraint::Length(1), // docker / filler
    ];
    let rows = Layout::vertical(row_constraints).split(inner);

    // --- CPU gauge ---
    let cpu_ratio = (health.cpu_percent / 100.0).clamp(0.0, 1.0) as f64;
    let cpu_fill_color = cpu_color(health.cpu_percent);
    let cpu_gauge = LineGauge::default()
        .ratio(cpu_ratio)
        .label(format!("CPU  {:.1}%", health.cpu_percent))
        .filled_style(Style::default().fg(cpu_fill_color))
        .style(Style::default().fg(colors::TEXT_DIM));
    frame.render_widget(cpu_gauge, rows[0]);

    // --- CPU sparkline ---
    if let Some(history) = app.health_history.get(&agent.info.name) {
        let cpu_data: Vec<u64> = history.cpu.iter().copied().collect();
        let sparkline = Sparkline::default()
            .data(&cpu_data)
            .max(100)
            .style(Style::default().fg(cpu_fill_color));
        frame.render_widget(sparkline, rows[1]);
    }

    // --- RAM gauge ---
    let ram_ratio = if health.memory_total_gb > 0.0 {
        (health.memory_used_gb / health.memory_total_gb).clamp(0.0, 1.0) as f64
    } else {
        0.0
    };
    let ram_fill_color = ram_color(ram_ratio as f32);
    let ram_gauge = LineGauge::default()
        .ratio(ram_ratio)
        .label(format!(
            "RAM  {:.1}/{:.1} GB",
            health.memory_used_gb, health.memory_total_gb
        ))
        .filled_style(Style::default().fg(ram_fill_color))
        .style(Style::default().fg(colors::TEXT_DIM));
    frame.render_widget(ram_gauge, rows[2]);

    // --- RAM sparkline ---
    if let Some(history) = app.health_history.get(&agent.info.name) {
        let ram_data: Vec<u64> = history.ram.iter().copied().collect();
        let sparkline = Sparkline::default()
            .data(&ram_data)
            .max(100)
            .style(Style::default().fg(ram_fill_color));
        frame.render_widget(sparkline, rows[3]);
    }

    // --- Disk gauge ---
    let disk_ratio = if health.disk_total_gb > 0.0 {
        (health.disk_used_gb / health.disk_total_gb).clamp(0.0, 1.0) as f64
    } else {
        0.0
    };
    let disk_fill_color = ram_color(disk_ratio as f32); // reuse threshold logic
    let disk_gauge = LineGauge::default()
        .ratio(disk_ratio)
        .label(format!(
            "Disk {:.1}/{:.1} GB",
            health.disk_used_gb, health.disk_total_gb
        ))
        .filled_style(Style::default().fg(disk_fill_color))
        .style(Style::default().fg(colors::TEXT_DIM));
    frame.render_widget(disk_gauge, rows[4]);

    // --- Load / uptime ---
    let load_line = Line::from(vec![
        Span::styled("Load: ", Style::default().fg(colors::TEXT_DIM)),
        Span::styled(
            format!(
                "{:.2} {:.2} {:.2}",
                health.load_avg[0], health.load_avg[1], health.load_avg[2]
            ),
            Style::default().fg(colors::TEXT),
        ),
        Span::styled("   Uptime: ", Style::default().fg(colors::TEXT_DIM)),
        Span::styled(
            format_duration(health.uptime_seconds),
            Style::default().fg(colors::TEXT),
        ),
    ]);
    frame.render_widget(Paragraph::new(load_line), rows[5]);

    // --- Docker ---
    if let Some(containers) = &health.docker_containers {
        let running = containers.iter().filter(|c| c.running).count();
        let stopped = containers.len() - running;
        let docker_line = Line::from(vec![
            Span::styled("Docker: ", Style::default().fg(colors::TEXT_DIM)),
            Span::styled(
                format!("{running} running"),
                Style::default().fg(colors::PRIMARY),
            ),
            Span::styled(
                format!(", {stopped} stopped"),
                Style::default().fg(colors::TEXT_DIM),
            ),
        ]);
        frame.render_widget(Paragraph::new(docker_line), rows[6]);
    }
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

/// Choose color based on a utilization ratio (0.0–1.0).
fn ram_color(ratio: f32) -> ratatui::style::Color {
    if ratio > 0.90 {
        colors::ERROR
    } else if ratio > 0.70 {
        colors::WARNING
    } else {
        colors::PRIMARY
    }
}
