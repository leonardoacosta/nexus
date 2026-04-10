use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use crate::app::{NotificationManager, Severity, colors};

/// Render the most recent notification in the given status bar area.
///
/// If a notification is present, it replaces the normal status bar content
/// in the rightmost portion of the area.
pub fn render_notification(frame: &mut Frame, area: Rect, manager: &NotificationManager) {
    let notification = match manager.latest() {
        Some(n) => n,
        None => return,
    };

    let color = match notification.severity {
        Severity::Info => colors::PRIMARY,
        Severity::Warning => colors::WARNING,
        Severity::Error => colors::ERROR,
    };

    let bar = Paragraph::new(Line::from(vec![Span::styled(
        format!(" {} ", notification.message),
        Style::default().fg(color),
    )]))
    .style(Style::default().bg(colors::SURFACE));

    frame.render_widget(bar, area);
}

/// Format a session event into a notification message.
///
/// Returns `(message, severity)` for Stale/Errored status transitions,
/// or `None` for other events.
pub fn format_status_notification(
    session_id: &str,
    project: Option<&str>,
    new_status: i32,
) -> Option<(String, Severity)> {
    let short_id = &session_id[..session_id.len().min(4)];
    let label = project.unwrap_or("?");

    // Status values match proto: 3 = Stale, 4 = Errored.
    match new_status {
        3 => Some((
            format!("\u{25CC} {label}#{short_id} stale"),
            Severity::Warning,
        )),
        4 => Some((
            format!("\u{2716} {label}#{short_id} errored"),
            Severity::Error,
        )),
        _ => None,
    }
}
