use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Borders, Padding, Paragraph, Row, Scrollbar, ScrollbarOrientation,
    ScrollbarState, Table, TableState, Wrap,
};

use crate::app::{App, colors, format_age};

/// Render the spec review screen.
pub fn render_specs(frame: &mut Frame, area: Rect, app: &mut App) {
    // If a spec detail is open, render the detail view instead.
    if app.spec_detail.is_some() {
        render_spec_detail(frame, area, app);
        return;
    }

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_spec_table(frame, chunks[1], app);
    render_status_bar(frame, chunks[2], app);
}

fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let pending = app.pending_spec_count;
    let hint = if pending > 0 {
        format!("  Tab: switch  j/k: navigate  Enter: detail  q: quit  ({pending} pending)")
    } else {
        "  Tab: switch  j/k: navigate  Enter: detail  q: quit".to_string()
    };

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            app.current_screen.title(),
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(hint, Style::default().fg(colors::TEXT_DIM)),
    ]))
    .block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, area);
}

fn render_spec_table(frame: &mut Frame, area: Rect, app: &mut App) {
    let specs = &app.cached_specs;

    if specs.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "No specs found. Waiting for agent data...",
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

    let rows: Vec<Row<'_>> = specs
        .iter()
        .map(|spec| {
            let status_color = match spec.status.as_str() {
                "unread" => colors::WARNING,
                "read" => colors::TEXT,
                "approved" => colors::PRIMARY,
                "applied" => colors::SECONDARY,
                "rejected" => colors::ERROR,
                _ => colors::TEXT_DIM,
            };

            let status_dot = match spec.status.as_str() {
                "unread" => "\u{25CF}",   // filled circle (attention)
                "read" => "\u{25CB}",     // open circle
                "approved" => "\u{2713}", // checkmark
                "applied" => "\u{2714}",  // heavy checkmark
                "rejected" => "\u{2716}", // X mark
                _ => "\u{25CC}",
            };

            let tasks_base = match (spec.tasks_done, spec.tasks_total) {
                (Some(done), Some(total)) => format!("{done}/{total}"),
                _ => "-".to_string(),
            };

            // Velocity trend from snapshots.
            let spec_snapshots: Vec<&nexus_core::proto::SpecVelocityEntry> = app
                .spec_velocity
                .iter()
                .filter(|e| e.spec_name == spec.name && e.project == spec.project)
                .collect();
            let (trend_str, trend_color) = if spec_snapshots.len() >= 2 {
                let earliest = spec_snapshots.first().unwrap().completed_tasks;
                let latest = spec_snapshots.last().unwrap().completed_tasks;
                if latest > earliest {
                    (" \u{2191}", colors::PRIMARY) // ↑ green — progressing
                } else if latest == earliest {
                    (" \u{2192}", colors::WARNING) // → yellow — stalled
                } else {
                    (" \u{2193}", colors::ERROR) // ↓ red — regressing
                }
            } else {
                ("", colors::TEXT_DIM)
            };

            let age = spec
                .discovered_at
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| format_age(dt.with_timezone(&chrono::Utc)))
                .unwrap_or_else(|| "-".to_string());

            Row::new(vec![
                Line::from(Span::styled(
                    spec.project.clone(),
                    Style::default().fg(colors::SECONDARY),
                )),
                Line::from(Span::styled(
                    spec.name.clone(),
                    Style::default().fg(colors::TEXT),
                )),
                Line::from(vec![
                    Span::styled(format!("{status_dot} "), Style::default().fg(status_color)),
                    Span::styled(spec.status.clone(), Style::default().fg(status_color)),
                ]),
                Line::from(vec![
                    Span::styled(tasks_base, Style::default().fg(colors::TEXT_DIM)),
                    Span::styled(trend_str, Style::default().fg(trend_color)),
                ]),
                Line::from(Span::styled(age, Style::default().fg(colors::TEXT_DIM))),
            ])
        })
        .collect();

    let total_rows = rows.len();

    let header = Row::new(vec![
        Line::from(Span::styled(
            "PROJECT",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "SPEC",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "STATUS",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "TASKS",
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            "DISCOVERED",
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
        Constraint::Length(10), // project
        Constraint::Fill(1),    // spec name
        Constraint::Length(14), // status
        Constraint::Length(10), // tasks + trend
        Constraint::Length(12), // discovered
    ];

    let mut table_state = TableState::default();
    let selected = app.selected_index.min(specs.len().saturating_sub(1));
    table_state.select(Some(selected));

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

    // Reserve 1 column for scrollbar.
    let table_area = Rect {
        width: area.width.saturating_sub(1),
        ..area
    };
    let scrollbar_area = Rect {
        x: area.x + area.width.saturating_sub(1),
        width: 1,
        ..area
    };

    frame.render_stateful_widget(table, table_area, &mut table_state);

    let mut scrollbar_state = ScrollbarState::new(total_rows).position(selected);
    let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight);
    frame.render_stateful_widget(scrollbar, scrollbar_area, &mut scrollbar_state);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let total = app.cached_specs.len();
    let pending = app.pending_spec_count;
    let uptime = app.uptime_string();

    let bar = Paragraph::new(Line::from(vec![
        Span::raw(" "),
        Span::styled(
            format!("{total} specs"),
            Style::default().fg(colors::TEXT_DIM),
        ),
        Span::styled(
            format!(" \u{00B7} {pending} pending"),
            Style::default().fg(if pending > 0 {
                colors::WARNING
            } else {
                colors::TEXT_DIM
            }),
        ),
        Span::styled(
            format!(" \u{00B7} \u{2191}{uptime}"),
            Style::default().fg(colors::TEXT_DIM),
        ),
    ]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

/// Render the spec detail overlay.
fn render_spec_detail(frame: &mut Frame, area: Rect, app: &mut App) {
    let detail = match &app.spec_detail {
        Some(d) => d,
        None => return,
    };

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    // Title bar with spec name and keybinding hints.
    let status_color = match detail.status.as_str() {
        "unread" => colors::WARNING,
        "read" => colors::TEXT,
        "approved" => colors::PRIMARY,
        "applied" => colors::SECONDARY,
        "rejected" => colors::ERROR,
        _ => colors::TEXT_DIM,
    };

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            format!("{}/{}", detail.project, detail.name),
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  [{}]", detail.status),
            Style::default().fg(status_color),
        ),
        Span::styled(
            "  a: approve  x: reject  Esc: back",
            Style::default().fg(colors::TEXT_DIM),
        ),
    ]))
    .block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, chunks[0]);

    // Content area: title, summary, and task progress.
    let mut lines: Vec<Line<'_>> = Vec::new();

    if let Some(ref title_text) = detail.title {
        lines.push(Line::from(Span::styled(
            title_text.clone(),
            Style::default()
                .fg(colors::SECONDARY)
                .add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(""));
    }

    if let Some(ref summary) = detail.summary {
        for line in summary.lines() {
            lines.push(Line::from(Span::styled(
                line.to_string(),
                Style::default().fg(colors::TEXT),
            )));
        }
        lines.push(Line::from(""));
    }

    if let (Some(done), Some(total)) = (detail.tasks_done, detail.tasks_total) {
        let pct = if total > 0 {
            (done as f64 / total as f64 * 100.0) as u32
        } else {
            0
        };
        lines.push(Line::from(vec![
            Span::styled(
                "Tasks: ",
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{done}/{total} ({pct}%)"),
                Style::default().fg(colors::PRIMARY),
            ),
        ]));

        // Simple progress bar.
        let bar_width = 30usize;
        let filled = if total > 0 {
            (done as usize * bar_width) / total as usize
        } else {
            0
        };
        let empty = bar_width.saturating_sub(filled);
        lines.push(Line::from(vec![
            Span::styled(
                "\u{2588}".repeat(filled),
                Style::default().fg(colors::PRIMARY),
            ),
            Span::styled(
                "\u{2591}".repeat(empty),
                Style::default().fg(colors::TEXT_DIM),
            ),
        ]));
    }

    let content = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((detail.scroll_offset as u16, 0))
        .block(
            Block::default()
                .border_type(BorderType::Rounded)
                .borders(Borders::ALL)
                .border_style(Style::default().fg(colors::TEXT_DIM))
                .padding(Padding::horizontal(1)),
        );
    frame.render_widget(content, chunks[1]);

    // Status bar.
    let bar = Paragraph::new(Line::from(vec![
        Span::raw(" "),
        Span::styled(
            format!("{}/{}", detail.project, detail.name),
            Style::default().fg(colors::TEXT_DIM),
        ),
        Span::styled(
            format!(" \u{00B7} status: {}", detail.status),
            Style::default().fg(status_color),
        ),
    ]))
    .style(Style::default().bg(colors::SURFACE));
    frame.render_widget(bar, chunks[2]);
}
