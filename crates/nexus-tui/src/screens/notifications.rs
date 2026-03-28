//! Notification settings panel overlay.
//!
//! Renders as a centered floating panel over the current screen.
//! Keyboard shortcuts:
//!
//! - j/Down / k/Up — navigate project list
//! - v             — cycle verbosity (silent → brief → verbose)
//! - a             — toggle announce_agents
//! - s             — toggle announce_specs
//! - d             — reset project to defaults (no-op on defaults row)
//! - Esc / q       — close panel

use nexus_core::config::Verbosity;
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph};

use crate::app::{App, NotificationPanelState, colors};

/// Render the notification settings panel as a centered overlay.
pub fn render_notification_panel(frame: &mut Frame, app: &App) {
    let panel_state = match &app.notification_panel {
        Some(s) => s,
        None => return,
    };

    let area = frame.area();

    // Center: 70% width, enough rows for header + rows + footer.
    let row_count = panel_state.rows.len().max(1) as u16;
    // 3 (border+header) + row_count + 2 (footer) = row_count + 5, max 30
    let panel_height = (row_count + 7).min(30);
    let panel_area = area.centered(Constraint::Percentage(72), Constraint::Length(panel_height));

    frame.render_widget(Clear, panel_area);

    let block = Block::default()
        .title(Span::styled(
            " Notification Settings ",
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD),
        ))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(colors::PRIMARY));

    let inner = block.inner(panel_area);
    frame.render_widget(block, panel_area);

    // Split inner: table header + rows + footer hints
    let row_area_height = inner.height.saturating_sub(2); // 1 header + 1 footer
    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(row_area_height),
        Constraint::Length(1),
    ])
    .split(inner);

    render_header(frame, chunks[0]);
    render_rows(frame, chunks[1], panel_state);
    render_footer(frame, chunks[2]);
}

fn render_header(frame: &mut Frame, area: ratatui::layout::Rect) {
    let line = Line::from(vec![
        Span::styled(
            format!("  {:<18} {:<10} {:<8} {:<8}", "PROJECT", "VERBOSITY", "AGENTS", "SPECS"),
            Style::default()
                .fg(colors::TEXT_DIM)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

fn render_rows(frame: &mut Frame, area: ratatui::layout::Rect, state: &NotificationPanelState) {
    // Scrolling offset: ensure the selected row is always visible.
    let visible_height = area.height as usize;
    let scroll_offset = if state.selected >= visible_height {
        state.selected - visible_height + 1
    } else {
        0
    };

    let visible_rows = state
        .rows
        .iter()
        .enumerate()
        .skip(scroll_offset)
        .take(visible_height);

    let mut lines: Vec<Line<'static>> = Vec::new();
    for (idx, row) in visible_rows {
        let is_selected = idx == state.selected;
        let rules = if row.project.is_empty() {
            &state.config.defaults
        } else {
            state.config.rules_for(&row.project)
        };

        let project_label = if row.project.is_empty() {
            "(defaults)".to_string()
        } else {
            row.project.clone()
        };
        let has_override = !row.project.is_empty() && state.config.projects.contains_key(&row.project);
        let override_tag = if has_override { "" } else { " (default)" };

        let verbosity_label = match rules.verbosity {
            Verbosity::Verbose => "\u{2588}\u{2588} verbose",
            Verbosity::Brief => "\u{2591}\u{2591} brief  ",
            Verbosity::Silent => ".. silent ",
        };

        let agents_label = if rules.announce_agents { "\u{2713}" } else { "\u{2717}" };
        let specs_label = if rules.announce_specs { "\u{2713}" } else { "\u{2717}" };

        let cursor = if is_selected { "\u{25B8}" } else { " " };

        let row_text = format!(
            "{} {:<18} {:<10} {:<8} {:<8}{}",
            cursor,
            project_label,
            verbosity_label,
            agents_label,
            specs_label,
            override_tag,
        );

        let style = if is_selected {
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(colors::TEXT)
        };

        lines.push(Line::from(Span::styled(row_text, style)));
    }

    let para = Paragraph::new(lines);
    frame.render_widget(para, area);
}

fn render_footer(frame: &mut Frame, area: ratatui::layout::Rect) {
    let hints = Line::from(vec![Span::styled(
        " [v] verbosity  [a] agents  [s] specs  [d] reset to default  [Esc] close",
        Style::default().fg(colors::TEXT_DIM),
    )]);
    frame.render_widget(Paragraph::new(hints), area);
}
