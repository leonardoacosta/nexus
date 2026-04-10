mod content;
mod header;
mod status;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};

use crate::app::{App, InputMode};

/// Compute the height in terminal rows for the textarea input bar.
///
/// Reads the line count from the TextArea directly.  Cap at 5 content lines
/// plus 1 border row.
fn textarea_bar_height(app: &App) -> u16 {
    let line_count = app.stream_textarea.lines().len().max(1);
    (line_count.min(5) as u16) + 1
}

/// Render the stream attach view.
pub fn render_stream(frame: &mut Frame, area: Rect, app: &mut App) {
    // Keep the stream view's terminal width in sync with the actual frame size.
    if let Some(sv) = &mut app.stream_view {
        sv.terminal_width = area.width;
    }

    let bar_height = if app.stream_executing {
        2 // executing spinner: 1 content line + 1 border
    } else {
        textarea_bar_height(app)
    };

    // Reserve 1 row for search bar when in search mode.
    let show_search_bar = app.input_mode == InputMode::StreamSearch
        || app
            .stream_view
            .as_ref()
            .is_some_and(|sv| sv.search.is_some());

    let chunks = if show_search_bar {
        Layout::vertical([
            Constraint::Length(3),          // title bar
            Constraint::Min(1),             // log view
            Constraint::Length(1),          // search bar
            Constraint::Length(bar_height), // input bar (dynamic)
            Constraint::Length(1),          // status bar
        ])
        .split(area)
    } else {
        // Use a 5-element layout with search bar height 0 to keep indices consistent.
        Layout::vertical([
            Constraint::Length(3),          // title bar
            Constraint::Min(1),             // log view
            Constraint::Length(0),          // search bar (hidden)
            Constraint::Length(bar_height), // input bar (dynamic)
            Constraint::Length(1),          // status bar
        ])
        .split(area)
    };

    header::render_title_bar(frame, chunks[0], app);
    content::render_log_view(frame, chunks[1], app);
    if show_search_bar {
        status::render_search_bar(frame, chunks[2], app);
    }
    status::render_input_bar(frame, chunks[3], app);
    status::render_status_bar(frame, chunks[4], app);
}
