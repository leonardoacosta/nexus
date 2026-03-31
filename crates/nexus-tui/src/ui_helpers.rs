//! UI helper functions extracted from main.rs
//!
//! Contains: launch_editor, render_tabs, which_bin, handle_mouse.

use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use ratatui::DefaultTerminal;
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Tabs;

use crate::RpcCommand;
use crate::app::{self, App, Screen};
use anyhow::Result;
use tokio::sync::mpsc;

/// Leave alternate screen, spawn $EDITOR (with vi/nano fallback) on a temp
/// file, read the result, re-enter alternate screen, then send the prompt.
pub(crate) fn launch_editor(
    terminal: &mut DefaultTerminal,
    app: &mut App,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> Result<()> {
    // Resolve editor binary: $EDITOR → vi → nano.
    let editor = std::env::var("EDITOR")
        .ok()
        .filter(|e| !e.is_empty())
        .or_else(|| which_bin("vi"))
        .or_else(|| which_bin("nano"));

    let Some(editor) = editor else {
        app.status_message = Some("no editor found: set $EDITOR or install vi/nano".to_string());
        return Ok(());
    };

    // Write current input buffer to a temp file so the user can edit it.
    let tmp_path = std::env::temp_dir().join("nexus-editor-prompt.txt");
    std::fs::write(&tmp_path, app.stream_input_text())?;

    // Leave TUI alternate screen.
    execute!(std::io::stdout(), DisableMouseCapture)?;
    ratatui::try_restore()?;

    // Spawn editor and wait for it to exit.
    let status = std::process::Command::new(&editor).arg(&tmp_path).status();

    // Re-enter TUI alternate screen regardless of editor outcome.
    *terminal = ratatui::try_init()?;
    execute!(std::io::stdout(), EnableMouseCapture)?;
    terminal.clear()?;

    match status {
        Err(e) => {
            app.status_message = Some(format!("editor launch failed: {e}"));
            return Ok(());
        }
        Ok(s) if !s.success() => {
            app.status_message = Some(format!(
                "editor exited with status: {}",
                s.code().unwrap_or(-1)
            ));
            return Ok(());
        }
        Ok(_) => {}
    }

    // Read back the file contents.
    let content = match std::fs::read_to_string(&tmp_path) {
        Ok(c) => c,
        Err(e) => {
            app.status_message = Some(format!("failed to read editor output: {e}"));
            return Ok(());
        }
    };

    // Trim trailing newline that most editors append.
    let prompt = content.trim_end_matches('\n').to_string();

    if prompt.is_empty() {
        app.status_message = Some("editor: empty input, prompt aborted".to_string());
        return Ok(());
    }

    // Set the textarea content to the editor output, then submit via the
    // shared submit_prompt method.
    app.stream_input_set(&prompt);
    app.submit_prompt(rpc_tx);

    Ok(())
}

/// Render the tab bar showing Dashboard / Health / Projects.
///
/// The active tab is highlighted with an underline. Detail, Palette, and
/// StreamAttach are not shown as tabs (they are transient screens).
pub(crate) fn render_tabs(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, app: &App) {
    use app::colors;

    let tab_labels: Vec<Line<'_>> = vec![
        Line::from("  Dashboard  "),
        Line::from("  Health  "),
        Line::from("  Projects  "),
    ];

    // Map the current screen to a tab index (0, 1, or 2).
    // For transient screens (Detail, Palette, StreamAttach) keep highlighting
    // Dashboard (index 0) as the "home" tab.
    let selected_tab = match app.current_screen {
        app::Screen::Dashboard | app::Screen::Palette => 0,
        app::Screen::Health => 1,
        app::Screen::Projects => 2,
        app::Screen::Detail | app::Screen::StreamAttach => 0,
    };

    let tabs = Tabs::new(tab_labels)
        .select(selected_tab)
        .style(Style::default().fg(colors::TEXT_DIM))
        .highlight_style(
            Style::default()
                .fg(colors::PRIMARY)
                .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
        )
        .divider("|");

    frame.render_widget(tabs, area);
}

/// Return the path to `bin` if it exists somewhere on `$PATH`, else `None`.
pub(crate) fn which_bin(bin: &str) -> Option<String> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(bin).exists()))
        .and_then(|found| if found { Some(bin.to_string()) } else { None })
}

/// Handle mouse events (scroll wheel for navigation).
pub(crate) fn handle_mouse(app: &mut App, mouse: crossterm::event::MouseEvent) {
    use crossterm::event::MouseEventKind;
    match mouse.kind {
        MouseEventKind::ScrollUp => match app.current_screen {
            Screen::StreamAttach => {
                if let Some(sv) = &mut app.stream_view {
                    sv.auto_scroll = false;
                    sv.scroll_offset = sv.scroll_offset.saturating_sub(3);
                }
            }
            _ => {
                app.selected_index = app.selected_index.saturating_sub(1);
            }
        },
        MouseEventKind::ScrollDown => {
            match app.current_screen {
                Screen::StreamAttach => {
                    if let Some(sv) = &mut app.stream_view {
                        sv.auto_scroll = false;
                        sv.scroll_offset = sv.scroll_offset.saturating_add(3);
                        // Clamp to max using total display lines.
                        let max = sv.total_display_lines().saturating_sub(1);
                        if sv.scroll_offset >= max {
                            sv.scroll_offset = max;
                            sv.auto_scroll = true;
                        }
                    }
                }
                _ => {
                    let max = app.session_count().saturating_sub(1);
                    app.selected_index = (app.selected_index + 1).min(max);
                }
            }
        }
        _ => {}
    }
}
