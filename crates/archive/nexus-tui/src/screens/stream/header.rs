use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, colors};

pub fn render_title_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let label = sv.map(|s| s.session_label.as_str()).unwrap_or("?");

    // Build the heartbeat badge spans (dot + session type label).
    let badge_spans: Vec<Span<'_>> = if let Some(sv) = sv {
        if let Some(ref stype) = sv.session_type {
            let (dot, dot_style) = if sv.heartbeat_alive {
                // Pulse: alternate between filled and hollow every 10 ticks.
                if (app.tick_count / 10).is_multiple_of(2) {
                    ("\u{25CF}", Style::default().fg(colors::PRIMARY)) // ●
                } else {
                    ("\u{25CB}", Style::default().fg(colors::PRIMARY_DIM)) // ○
                }
            } else {
                // Stale — static dim hollow dot.
                ("\u{25CB}", Style::default().fg(colors::TEXT_DIM)) // ○
            };
            vec![
                Span::styled("  ", Style::default()),
                Span::styled(dot, dot_style),
                Span::styled(
                    format!(" {stype}"),
                    Style::default()
                        .fg(colors::TEXT_DIM)
                        .add_modifier(Modifier::DIM),
                ),
            ]
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    let mut spans = vec![
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
    ];
    spans.extend(badge_spans);

    // Session tab indicators: [1:label] [2:label] ...
    if !app.session_tabs.is_empty() {
        spans.push(Span::styled("  ", Style::default()));
        for (i, tab) in app.session_tabs.iter().enumerate() {
            let tab_label = tab.project.as_deref().unwrap_or(&tab.session_label);
            // Truncate label to 6 chars.
            let short: String = tab_label.chars().take(6).collect();
            let is_active = app.active_tab == Some(i);
            let style = if is_active {
                Style::default()
                    .fg(colors::PRIMARY)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(colors::TEXT_DIM)
            };
            spans.push(Span::styled(format!("[{}:{short}]", i + 1), style));
            spans.push(Span::styled(" ", Style::default()));
        }
    }

    spans.push(Span::styled(
        "  q: back  j/k: scroll  /: search  y: yank  v: filter  i: input  ?: help",
        Style::default().fg(colors::TEXT_DIM),
    ));

    let title = Paragraph::new(Line::from(spans)).block(
        Block::default()
            .borders(Borders::BOTTOM)
            .border_style(Style::default().fg(colors::TEXT_DIM)),
    );
    frame.render_widget(title, area);
}
