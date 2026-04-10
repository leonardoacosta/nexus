use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::app::{App, InputMode, StreamVerbosity, colors};

pub fn render_search_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();

    let (query, current, total) = if let Some(sv) = sv {
        if let Some(ref search) = sv.search {
            (
                search.query.as_str(),
                if search.match_positions.is_empty() {
                    0
                } else {
                    search.current_match + 1
                },
                search.match_positions.len(),
            )
        } else {
            ("", 0, 0)
        }
    } else {
        ("", 0, 0)
    };

    let in_search_mode = app.input_mode == InputMode::StreamSearch;

    let mut spans = vec![
        Span::styled(
            " / ",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(query.to_owned(), Style::default().fg(colors::TEXT)),
    ];

    if in_search_mode {
        spans.push(Span::styled(
            "\u{2588}",
            Style::default().fg(colors::PRIMARY),
        ));
    }

    spans.push(Span::styled(
        format!("  ({current}/{total} matches)"),
        Style::default().fg(colors::TEXT_DIM),
    ));

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));
    frame.render_widget(bar, area);
}

pub fn render_input_bar(frame: &mut Frame, area: Rect, app: &mut App) {
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(colors::TEXT_DIM));

    if app.stream_executing {
        // Show spinner during execution with elapsed time.
        let spinner_chars = [
            '\u{280B}', '\u{2819}', '\u{2839}', '\u{2838}', '\u{283C}', '\u{2834}', '\u{2826}',
            '\u{2827}', '\u{2807}', '\u{280F}',
        ];
        let idx = (app.tick_count / 3) % spinner_chars.len();
        let spinner = spinner_chars[idx];
        let elapsed = app
            .stream_exec_start
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let content = Paragraph::new(Line::from(vec![Span::styled(
            format!(" {spinner} executing... ({elapsed:.1}s)"),
            Style::default().fg(colors::WARNING),
        )]))
        .block(block);
        frame.render_widget(content, area);
    } else if app.stream_input_is_empty() && app.input_mode != InputMode::StreamInput {
        // Show placeholder text when the buffer is empty and not in input mode.
        let content = Paragraph::new(Line::from(vec![
            Span::styled(" > ", Style::default().fg(colors::PRIMARY)),
            Span::styled(
                "press i to type a prompt, Ctrl+E for editor",
                Style::default()
                    .fg(colors::TEXT_DIM)
                    .add_modifier(Modifier::DIM),
            ),
        ]))
        .block(block);
        frame.render_widget(content, area);
    } else {
        // Reserve the top row for the border; render the TextArea in the
        // remaining space.
        let inner = Rect {
            x: area.x,
            y: area.y + 1,
            width: area.width,
            height: area.height.saturating_sub(1),
        };
        // Draw the top border.
        frame.render_widget(block, area);

        // Configure textarea style to match the brand palette and render it.
        app.stream_textarea
            .set_style(Style::default().fg(colors::TEXT));
        app.stream_textarea.set_cursor_style(
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::REVERSED),
        );
        // Remove the textarea's own block so we can use our border above.
        app.stream_textarea
            .set_block(Block::default().borders(Borders::NONE));
        frame.render_widget(&app.stream_textarea, inner);
    }
}

pub fn render_status_bar(frame: &mut Frame, area: Rect, app: &App) {
    let sv = app.stream_view.as_ref();
    let line_count = sv.map(|s| s.total_display_lines()).unwrap_or(0);
    let auto_scroll = sv.is_some_and(|s| s.auto_scroll);

    let scroll_indicator = if auto_scroll {
        "\u{25BC} follow" // ▼ follow
    } else {
        "\u{25B2} scrolled" // ▲ scrolled
    };

    let mut spans: Vec<Span<'_>> = vec![Span::styled(
        format!(" {line_count} events \u{00B7} {scroll_indicator}"),
        Style::default().fg(colors::TEXT_DIM),
    )];

    if let Some(sv) = sv {
        // Verbosity indicator
        let verbosity_label = match sv.verbosity {
            StreamVerbosity::Minimal => "MIN",
            StreamVerbosity::Normal => "NRM",
            StreamVerbosity::Verbose => "VRB",
        };
        spans.push(Span::styled(
            format!(" \u{00B7} [{verbosity_label}]"),
            Style::default().fg(colors::TEXT_DIM),
        ));

        // System event count
        if sv.system_event_count > 0 {
            spans.push(Span::styled(
                format!(" \u{00B7} {} sys", sv.system_event_count),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }

        // Model name
        if let Some(ref model) = sv.model {
            spans.push(Span::styled(
                format!(" \u{00B7} {model}"),
                Style::default().fg(colors::SECONDARY),
            ));
        }

        // Rate limit utilization with color coding
        if let Some(rl) = sv.rate_limit_utilization {
            let pct = (rl * 100.0).round() as u32;
            let rl_color = if rl < 0.50 {
                colors::PRIMARY // green
            } else if rl < 0.80 {
                colors::WARNING // yellow
            } else {
                colors::ERROR // red
            };
            spans.push(Span::styled(
                format!(" \u{00B7} RL: {pct}%"),
                Style::default().fg(rl_color),
            ));
        }

        // Total cost
        if let Some(cost) = sv.total_cost_usd {
            spans.push(Span::styled(
                format!(" \u{00B7} ${cost:.2}"),
                Style::default().fg(colors::TEXT_DIM),
            ));
        }
    }

    let bar = Paragraph::new(Line::from(spans)).style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}
