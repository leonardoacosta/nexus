use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, colors};

/// Render the stream attach view.
pub fn render_stream(frame: &mut Frame, app: &mut App) {
    let area = frame.area();

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    render_title_bar(frame, chunks[0], app);
    render_log_view(frame, chunks[1], app);
    render_status_bar(frame, chunks[2], app);
}

fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let label = app
        .stream_view
        .as_ref()
        .map(|sv| sv.session_label.as_str())
        .unwrap_or("?");

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            "STREAM ATTACH",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  {label}"),
            Style::default()
                .fg(colors::SECONDARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            "  q: back  j/k: scroll  End: follow",
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

fn render_log_view(frame: &mut Frame, area: Rect, app: &mut App) {
    let visible_height = area.height as usize;

    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => {
            let msg = Paragraph::new(Line::from(vec![Span::styled(
                "No stream data.",
                Style::default().fg(colors::TEXT_DIM),
            )]));
            frame.render_widget(msg, area);
            return;
        }
    };

    // Update auto-scroll position before rendering.
    sv.update_auto_scroll(visible_height);

    if sv.lines.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "Waiting for events...",
            Style::default().fg(colors::TEXT_DIM),
        )]));
        frame.render_widget(msg, area);
        return;
    }

    let visible_lines: Vec<Line<'_>> = sv
        .lines
        .iter()
        .skip(sv.scroll_offset)
        .take(visible_height)
        .map(|line| {
            Line::from(Span::styled(
                line.clone(),
                Style::default().fg(colors::TEXT),
            ))
        })
        .collect();

    let paragraph = Paragraph::new(visible_lines);
    frame.render_widget(paragraph, area);
}

fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let line_count = sv.map(|s| s.lines.len()).unwrap_or(0);
    let auto_scroll = sv.is_some_and(|s| s.auto_scroll);

    let scroll_indicator = if auto_scroll {
        "\u{25BC} follow" // ▼ follow
    } else {
        "\u{25B2} scrolled" // ▲ scrolled
    };

    let bar = Paragraph::new(Line::from(vec![Span::styled(
        format!(" {line_count} events \u{00B7} {scroll_indicator}"),
        Style::default().fg(colors::TEXT_DIM),
    )]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}
