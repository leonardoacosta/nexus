//! Key event handlers extracted from main.rs
//!
//! Contains per-mode key handlers and helper functions.

use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use tokio::sync::mpsc;

use crate::app::{App, InputMode, PaletteAction, Screen, SearchState, StreamVerbosity};
use crate::{KeyAction, RpcCommand};

/// Handle a key event. Returns the appropriate `KeyAction`.
pub(crate) fn handle_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    // Clear status message and dismiss notifications on any key press.
    app.status_message = None;
    app.notifications.dismiss_all();

    // Ctrl+C always quits.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        app.should_quit = true;
        return KeyAction::Quit;
    }

    // Dispatch based on input mode.
    match app.input_mode {
        InputMode::Normal => handle_normal_key(app, key, rpc_tx),
        InputMode::PaletteInput => {
            handle_palette_key(app, key, rpc_tx);
            KeyAction::Continue
        }
        InputMode::StartSessionAgent => {
            handle_agent_select_key(app, key, rpc_tx);
            KeyAction::Continue
        }
        InputMode::StartSessionProjectSelect => {
            handle_project_select_key(app, key, rpc_tx);
            KeyAction::Continue
        }
        InputMode::StartSessionCwd => {
            handle_cwd_input_key(app, key, rpc_tx);
            KeyAction::Continue
        }
        InputMode::ScratchpadEdit => {
            match key.code {
                KeyCode::Esc => {
                    app.close_scratchpad();
                }
                KeyCode::Enter => {
                    app.scratchpad_text.push('\n');
                }
                KeyCode::Backspace => {
                    app.scratchpad_text.pop();
                }
                KeyCode::Char(c) => {
                    app.scratchpad_text.push(c);
                }
                _ => {}
            }
            KeyAction::Continue
        }
        InputMode::StreamInput => handle_stream_input_key(app, key, rpc_tx),
        InputMode::StreamSearch => {
            handle_stream_search_key(app, key);
            KeyAction::Continue
        }
        InputMode::NotificationPanel => {
            handle_notification_panel_key(app, key);
            KeyAction::Continue
        }
    }
}

/// Key handling for the stream input bar.
///
/// - Enter (without Shift/Ctrl): send the buffer as a prompt.
/// - Shift+Enter or Ctrl+J: insert newline (passed through to TextArea).
/// - Ctrl+E: open external editor.
/// - Up/Down: navigate history when the textarea is empty.
/// - Esc: exit stream input mode.
/// - Everything else: passed through to the TextArea widget.
pub(crate) fn handle_stream_input_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    // All input is blocked while a command is executing, except Esc.
    if app.stream_executing {
        if key.code == KeyCode::Esc {
            app.input_mode = InputMode::Normal;
            app.stream_input_clear();
        }
        return KeyAction::Continue;
    }

    // Ctrl+E — open external editor.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('e') {
        return KeyAction::OpenEditor;
    }

    // Esc — exit stream input mode.
    if key.code == KeyCode::Esc {
        app.input_mode = InputMode::Normal;
        app.stream_input_clear();
        if let Some(sv) = &mut app.stream_view {
            sv.history_index = None;
        }
        return KeyAction::Continue;
    }

    // Plain Enter (without modifiers) — send the buffer.
    if key.code == KeyCode::Enter && !key.modifiers.contains(KeyModifiers::SHIFT) {
        app.submit_prompt(rpc_tx);
        return KeyAction::Continue;
    }

    // Up — navigate backward in history (only when textarea is empty).
    if key.code == KeyCode::Up && app.stream_input_is_empty() {
        if let Some(sv) = &mut app.stream_view
            && !sv.input_history.is_empty()
        {
            let new_idx = match sv.history_index {
                None => sv.input_history.len() - 1,
                Some(0) => 0,
                Some(i) => i - 1,
            };
            sv.history_index = Some(new_idx);
            let text = sv.input_history[new_idx].clone();
            app.stream_input_set(&text);
        }
        return KeyAction::Continue;
    }

    // Down — navigate forward in history.
    if key.code == KeyCode::Down
        && let Some(sv) = &mut app.stream_view
    {
        match sv.history_index {
            None => {} // Not navigating; let TextArea handle Down normally.
            Some(i) if i + 1 >= sv.input_history.len() => {
                sv.history_index = None;
                app.stream_input_clear();
                return KeyAction::Continue;
            }
            Some(i) => {
                let new_idx = i + 1;
                sv.history_index = Some(new_idx);
                let text = sv.input_history[new_idx].clone();
                app.stream_input_set(&text);
                return KeyAction::Continue;
            }
        }
    }

    // Any typing resets history navigation.
    if matches!(
        key.code,
        KeyCode::Char(_) | KeyCode::Backspace | KeyCode::Delete
    ) && let Some(sv) = &mut app.stream_view
    {
        sv.history_index = None;
    }

    // Pass the key through to the TextArea widget.
    // Wrap in Event::Key so the textarea's crossterm Input conversion fires.
    app.stream_textarea.input(Event::Key(key));

    KeyAction::Continue
}

/// Normal mode key handling.
pub(crate) fn handle_normal_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    match app.current_screen {
        Screen::Detail => handle_detail_key(app, key, rpc_tx),
        Screen::StreamAttach => handle_stream_key(app, key),
        Screen::Specs => handle_specs_key(app, key),
        _ => handle_list_key(app, key, rpc_tx),
    }
}

/// Key handling for list-based screens (Dashboard, Health, Projects).
pub(crate) fn handle_list_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    match key.code {
        KeyCode::Char('q') => {
            app.should_quit = true;
            KeyAction::Quit
        }
        KeyCode::Tab => {
            app.next_screen();
            KeyAction::Continue
        }
        KeyCode::BackTab => {
            app.prev_screen();
            KeyAction::Continue
        }
        KeyCode::Char('j') | KeyCode::Down => {
            app.move_down();
            KeyAction::Continue
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.move_up();
            KeyAction::Continue
        }
        KeyCode::Enter | KeyCode::Char('d') => {
            // On Dashboard: open detail for selected session.
            if app.current_screen == Screen::Dashboard
                && let Some(row) = app.cached_sessions().get(app.selected_index).cloned()
            {
                let session = row.session.clone();
                // Find the agent info.
                let agent_info = app
                    .agents
                    .iter()
                    .find(|a| a.info.name == row.agent_name)
                    .map(|a| a.info.clone())
                    .unwrap_or_else(|| nexus_core::agent::AgentSnapshot {
                        name: row.agent_name.clone(),
                        host: String::new(),
                        port: 0,
                        os: String::new(),
                        sessions: Vec::new(),
                        health: None,
                        connected: false,
                    });
                app.open_detail(session, agent_info);
            }
            KeyAction::Continue
        }
        KeyCode::Char(':') | KeyCode::Char('/') => {
            app.open_palette();
            KeyAction::Continue
        }
        KeyCode::Char('n') => {
            if app.current_screen == Screen::Dashboard {
                if let Some(agent_name) = app.begin_start_session() {
                    let _ = rpc_tx.try_send(RpcCommand::ListProjects { agent_name });
                }
            } else {
                // On Health and Projects screens, 'n' opens the notification panel.
                app.open_notification_panel();
            }
            KeyAction::Continue
        }
        KeyCode::Char('a') => {
            // Stream attach: works for all sessions (managed and ad-hoc).
            if app.current_screen == Screen::Dashboard
                && let Some(row) = app.cached_sessions().get(app.selected_index).cloned()
            {
                let session_id = row.session.id.clone();
                let agent_name = row.agent_name.clone();
                let project = row.session.project.as_deref().unwrap_or("?");
                let short_id = &session_id[..session_id.len().min(4)];
                let label = format!("{project}#{short_id}");
                app.open_stream_attach(session_id, label, agent_name);
                app.ensure_session_tab();
                app.input_mode = InputMode::StreamInput;
            }
            KeyAction::Continue
        }
        KeyCode::Char('e') => {
            // Open scratchpad for selected project on Projects screen.
            if app.current_screen == Screen::Projects
                && let Some(name) = app
                    .cached_project_summaries()
                    .get(app.selected_index)
                    .map(|p| p.name.clone())
            {
                app.open_scratchpad(&name);
            }
            KeyAction::Continue
        }
        KeyCode::Char('A') => {
            app.status_message = Some("use 'a' for interactive stream".to_string());
            KeyAction::Continue
        }
        _ => KeyAction::Continue,
    }
}

/// Key handling for the detail screen.
pub(crate) fn handle_detail_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.close_detail();
            KeyAction::Continue
        }
        KeyCode::Char('a') => {
            // Open stream attach view for the currently viewed session.
            if let Some((session, agent)) = &app.selected_session.clone() {
                let session_id = session.id.clone();
                let agent_name = agent.name.clone();
                let project = session.project.as_deref().unwrap_or("?");
                let short_id = &session_id[..session_id.len().min(4)];
                let label = format!("{project}#{short_id}");
                app.open_stream_attach(session_id, label, agent_name);
                app.ensure_session_tab();
                app.input_mode = InputMode::StreamInput;
            }
            KeyAction::Continue
        }
        KeyCode::Char('s') => {
            // Stop the currently viewed session.
            if let Some((session, _)) = &app.selected_session {
                let id = session.id.clone();
                let _ = rpc_tx.try_send(RpcCommand::StopSession { session_id: id });
            }
            KeyAction::Continue
        }
        _ => KeyAction::Continue,
    }
}

/// Key handling for the specs review screen.
pub(crate) fn handle_specs_key(app: &mut App, key: KeyEvent) -> KeyAction {
    // If a spec detail is open, handle detail-specific keys.
    if app.spec_detail.is_some() {
        return handle_spec_detail_key(app, key);
    }

    // List mode keys.
    match key.code {
        KeyCode::Char('q') => {
            app.should_quit = true;
            KeyAction::Quit
        }
        KeyCode::Tab => {
            app.next_screen();
            KeyAction::Continue
        }
        KeyCode::BackTab => {
            app.prev_screen();
            KeyAction::Continue
        }
        KeyCode::Char('j') | KeyCode::Down => {
            app.move_down();
            KeyAction::Continue
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.move_up();
            KeyAction::Continue
        }
        KeyCode::Enter => {
            // Open spec detail for the selected row.
            if let Some(spec) = app.cached_specs.get(app.selected_index).cloned() {
                app.spec_detail = Some(crate::app::SpecDetailState {
                    project: spec.project.clone(),
                    name: spec.name.clone(),
                    status: spec.status.clone(),
                    title: spec.title.clone(),
                    summary: spec.summary.clone(),
                    tasks_total: spec.tasks_total,
                    tasks_done: spec.tasks_done,
                    scroll_offset: 0,
                });
                // Fire-and-forget: mark spec as read via HTTP POST.
                let project = spec.project;
                let name = spec.name;
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let host =
                        std::env::var("NEXUS_AGENT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
                    let port = std::env::var("NEXUS_AGENT_PORT").unwrap_or_else(|_| "7402".into());
                    let url = format!("http://{host}:{port}/specs/{project}/{name}/read");
                    let _ = client.post(&url).send().await;
                });
            }
            KeyAction::Continue
        }
        KeyCode::Char(':') | KeyCode::Char('/') => {
            app.open_palette();
            KeyAction::Continue
        }
        _ => KeyAction::Continue,
    }
}

/// Key handling for the spec detail view overlay.
fn handle_spec_detail_key(app: &mut App, key: KeyEvent) -> KeyAction {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.spec_detail = None;
            KeyAction::Continue
        }
        KeyCode::Char('j') | KeyCode::Down => {
            if let Some(ref mut detail) = app.spec_detail {
                detail.scroll_offset = detail.scroll_offset.saturating_add(1);
            }
            KeyAction::Continue
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if let Some(ref mut detail) = app.spec_detail {
                detail.scroll_offset = detail.scroll_offset.saturating_sub(1);
            }
            KeyAction::Continue
        }
        KeyCode::Char('a') => {
            // Approve the spec via HTTP POST.
            if let Some(ref mut detail) = app.spec_detail {
                let project = detail.project.clone();
                let name = detail.name.clone();
                detail.status = "approved".to_string();
                // Update the cached spec list entry too.
                if let Some(entry) = app
                    .cached_specs
                    .iter_mut()
                    .find(|s| s.project == project && s.name == name)
                {
                    entry.status = "approved".to_string();
                }
                // Recompute pending count.
                app.pending_spec_count = app
                    .cached_specs
                    .iter()
                    .filter(|s| s.status == "unread" || s.status == "read")
                    .count();
                let project_c = project.clone();
                let name_c = name.clone();
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let host =
                        std::env::var("NEXUS_AGENT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
                    let port = std::env::var("NEXUS_AGENT_PORT").unwrap_or_else(|_| "7402".into());
                    let url = format!("http://{host}:{port}/specs/{project_c}/{name_c}/approve");
                    let _ = client.post(&url).send().await;
                });
                app.status_message = Some(format!("approved {project}/{name}"));
            }
            KeyAction::Continue
        }
        KeyCode::Char('x') => {
            // Reject the spec via HTTP POST.
            if let Some(ref mut detail) = app.spec_detail {
                let project = detail.project.clone();
                let name = detail.name.clone();
                detail.status = "rejected".to_string();
                // Update the cached spec list entry too.
                if let Some(entry) = app
                    .cached_specs
                    .iter_mut()
                    .find(|s| s.project == project && s.name == name)
                {
                    entry.status = "rejected".to_string();
                }
                // Recompute pending count.
                app.pending_spec_count = app
                    .cached_specs
                    .iter()
                    .filter(|s| s.status == "unread" || s.status == "read")
                    .count();
                let project_c = project.clone();
                let name_c = name.clone();
                tokio::spawn(async move {
                    let client = reqwest::Client::new();
                    let host =
                        std::env::var("NEXUS_AGENT_HOST").unwrap_or_else(|_| "127.0.0.1".into());
                    let port = std::env::var("NEXUS_AGENT_PORT").unwrap_or_else(|_| "7402".into());
                    let url = format!("http://{host}:{port}/specs/{project_c}/{name_c}/reject");
                    let _ = client.post(&url).send().await;
                });
                app.status_message = Some(format!("rejected {project}/{name}"));
            }
            KeyAction::Continue
        }
        _ => KeyAction::Continue,
    }
}

/// Key handling for the stream attach view.
pub(crate) fn handle_stream_key(app: &mut App, key: KeyEvent) -> KeyAction {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.close_stream_attach();
            KeyAction::Continue
        }
        KeyCode::Char('j') | KeyCode::Down => {
            if let Some(sv) = app.stream_view.as_mut() {
                // Use a reasonable default visible height; actual height is
                // only known at render time. 20 is a safe lower bound.
                sv.scroll_down(20);
            }
            KeyAction::Continue
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.scroll_up();
            }
            KeyAction::Continue
        }
        KeyCode::PageUp => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.page_up(20);
            }
            KeyAction::Continue
        }
        KeyCode::PageDown => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.page_down(20);
            }
            KeyAction::Continue
        }
        KeyCode::End => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.scroll_to_end();
            }
            KeyAction::Continue
        }
        KeyCode::Enter => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.toggle_block_at_scroll(20);
            }
            KeyAction::Continue
        }
        KeyCode::Char('i') => {
            app.input_mode = InputMode::StreamInput;
            KeyAction::Continue
        }
        KeyCode::Char('v') => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.verbosity = match sv.verbosity {
                    StreamVerbosity::Minimal => StreamVerbosity::Normal,
                    StreamVerbosity::Normal => StreamVerbosity::Verbose,
                    StreamVerbosity::Verbose => StreamVerbosity::Minimal,
                };
            }
            KeyAction::Continue
        }
        // Feature 1: Yank code block at current scroll position to clipboard.
        KeyCode::Char('y') => {
            yank_code_block(app);
            KeyAction::Continue
        }
        // Feature 3: Enter search mode.
        KeyCode::Char('/') => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.search = Some(SearchState {
                    query: String::new(),
                    match_positions: Vec::new(),
                    current_match: 0,
                });
            }
            app.input_mode = InputMode::StreamSearch;
            KeyAction::Continue
        }
        // Feature 3: Next/previous search match (after search confirmed).
        KeyCode::Char('n') => {
            search_next(app);
            KeyAction::Continue
        }
        KeyCode::Char('N') => {
            search_prev(app);
            KeyAction::Continue
        }
        // Feature 4: Quick session tabs (1-9).
        KeyCode::Char(c @ '1'..='9') => {
            let tab_idx = (c as usize) - ('1' as usize);
            switch_session_tab(app, tab_idx);
            KeyAction::Continue
        }
        _ => KeyAction::Continue,
    }
}

/// Yank the code block at the current scroll position to clipboard via OSC 52.
pub(crate) fn yank_code_block(app: &mut App) {
    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => return,
    };

    let scroll = sv.scroll_offset;

    // Find a code block that contains the current scroll position.
    let block = sv
        .code_blocks
        .iter()
        .find(|cb| scroll >= cb.start_line && scroll <= cb.end_line);

    if let Some(cb) = block {
        let content = cb.content.clone();
        if content.is_empty() {
            sv.notification_message = Some(("empty code block".to_string(), 0));
            return;
        }

        // OSC 52 clipboard write.
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
        let osc52 = format!("\x1b]52;c;{}\x07", encoded);
        if let Ok(()) = std::io::Write::write_all(&mut std::io::stdout(), osc52.as_bytes()) {
            let _ = std::io::Write::flush(&mut std::io::stdout());
        }

        let lines = content.lines().count();
        sv.notification_message = Some((format!("yanked {lines} lines"), 0));
    } else {
        sv.notification_message = Some(("no code block at cursor".to_string(), 0));
    }
}

/// Jump to the next search match.
pub(crate) fn search_next(app: &mut App) {
    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => return,
    };
    let search = match sv.search.as_mut() {
        Some(s) if !s.match_positions.is_empty() => s,
        _ => return,
    };
    search.current_match = (search.current_match + 1) % search.match_positions.len();
    let target = search.match_positions[search.current_match];
    sv.scroll_offset = target;
    sv.auto_scroll = false;
}

/// Jump to the previous search match.
pub(crate) fn search_prev(app: &mut App) {
    let sv = match app.stream_view.as_mut() {
        Some(sv) => sv,
        None => return,
    };
    let search = match sv.search.as_mut() {
        Some(s) if !s.match_positions.is_empty() => s,
        _ => return,
    };
    if search.current_match == 0 {
        search.current_match = search.match_positions.len() - 1;
    } else {
        search.current_match -= 1;
    }
    let target = search.match_positions[search.current_match];
    sv.scroll_offset = target;
    sv.auto_scroll = false;
}

/// Switch to a session tab by index.
pub(crate) fn switch_session_tab(app: &mut App, tab_idx: usize) {
    if tab_idx >= app.session_tabs.len() {
        return;
    }

    // If we're already on this tab, do nothing.
    if app.active_tab == Some(tab_idx) {
        return;
    }

    let target = &app.session_tabs[tab_idx];
    let target_session_id = target.session_id.clone();
    let target_label = target.session_label.clone();
    let target_agent = target.agent_name.clone();

    // Check if the current view is the same session.
    let current_is_different = app
        .stream_view
        .as_ref()
        .is_none_or(|sv| sv.session_id != target_session_id);

    if current_is_different {
        // Switch to the target session.
        app.open_stream_attach(target_session_id, target_label, target_agent);
        app.input_mode = InputMode::Normal; // stay in normal stream mode
    }
    app.active_tab = Some(tab_idx);
}

/// Key handling for stream search input mode.
pub(crate) fn handle_stream_search_key(app: &mut App, key: KeyEvent) {
    match key.code {
        KeyCode::Esc => {
            // Cancel search: clear everything.
            if let Some(sv) = app.stream_view.as_mut() {
                sv.search = None;
            }
            app.input_mode = InputMode::Normal;
        }
        KeyCode::Enter => {
            // Confirm search: keep highlights, go back to normal mode.
            app.input_mode = InputMode::Normal;
        }
        KeyCode::Backspace => {
            if let Some(sv) = app.stream_view.as_mut()
                && let Some(ref mut search) = sv.search
            {
                search.query.pop();
            }
        }
        KeyCode::Char(c) => {
            if let Some(sv) = app.stream_view.as_mut()
                && let Some(ref mut search) = sv.search
            {
                search.query.push(c);
            }
        }
        _ => {}
    }
}

/// Key handling for the notification settings panel overlay.
///
/// - j/Down / k/Up — navigate project list
/// - v             — cycle verbosity
/// - a             — toggle announce_agents
/// - s             — toggle announce_specs
/// - d             — reset project to defaults
/// - Esc / q       — close panel
pub(crate) fn handle_notification_panel_key(app: &mut App, key: KeyEvent) {
    if app.notification_panel.is_none() {
        app.input_mode = InputMode::Normal;
        return;
    }

    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.close_notification_panel();
            return;
        }
        _ => {}
    }

    let Some(panel) = app.notification_panel.as_mut() else {
        return;
    };

    match key.code {
        KeyCode::Char('j') | KeyCode::Down => {
            let max = panel.rows.len().saturating_sub(1);
            panel.selected = (panel.selected + 1).min(max);
        }
        KeyCode::Char('k') | KeyCode::Up => {
            panel.selected = panel.selected.saturating_sub(1);
        }
        KeyCode::Char('v') => {
            panel.cycle_verbosity();
            if let Err(e) = panel.save() {
                app.status_message = Some(format!("save failed: {e}"));
            }
        }
        KeyCode::Char('a') => {
            panel.toggle_agents();
            if let Err(e) = panel.save() {
                app.status_message = Some(format!("save failed: {e}"));
            }
        }
        KeyCode::Char('s') => {
            panel.toggle_specs();
            if let Err(e) = panel.save() {
                app.status_message = Some(format!("save failed: {e}"));
            }
        }
        KeyCode::Char('d') => {
            panel.reset_selected_to_default();
            if let Err(e) = panel.save() {
                app.status_message = Some(format!("save failed: {e}"));
            }
        }
        _ => {}
    }
}

/// Key handling for the palette input mode.
pub(crate) fn handle_palette_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) {
    match key.code {
        KeyCode::Esc => {
            app.close_palette();
        }
        KeyCode::Enter => {
            // Execute selected palette action.
            if let Some(entry) = app.palette_results.get(app.palette_selected).cloned() {
                app.close_palette();
                execute_palette_action(app, entry.action, rpc_tx);
            }
        }
        KeyCode::Down => {
            if !app.palette_results.is_empty() {
                app.palette_selected =
                    (app.palette_selected + 1).min(app.palette_results.len() - 1);
            }
        }
        KeyCode::Up => {
            if app.palette_selected > 0 {
                app.palette_selected -= 1;
            }
        }
        KeyCode::Backspace => {
            app.palette_query.pop();
            app.refresh_palette();
        }
        KeyCode::Char(c) => {
            app.palette_query.push(c);
            app.refresh_palette();
        }
        _ => {}
    }
}

/// Execute a palette action.
pub(crate) fn execute_palette_action(
    app: &mut App,
    action: PaletteAction,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) {
    match action {
        PaletteAction::GoSession {
            session_id,
            agent_name,
        } => {
            // Find the session and agent info from current state.
            if let Some(row) = app
                .cached_sessions()
                .iter()
                .find(|r| r.session.id == session_id)
                .cloned()
            {
                let session = row.session.clone();
                let agent_info = app
                    .agents
                    .iter()
                    .find(|a| a.info.name == agent_name)
                    .map(|a| a.info.clone())
                    .unwrap_or_else(|| nexus_core::agent::AgentSnapshot {
                        name: agent_name,
                        host: String::new(),
                        port: 0,
                        os: String::new(),
                        sessions: Vec::new(),
                        health: None,
                        connected: false,
                    });
                app.open_detail(session, agent_info);
            }
        }
        PaletteAction::GoScreen(screen) => {
            app.current_screen = screen;
            app.selected_index = 0;
        }
        PaletteAction::StartSession => {
            if let Some(agent_name) = app.begin_start_session() {
                let _ = rpc_tx.try_send(RpcCommand::ListProjects { agent_name });
            }
        }
        PaletteAction::StopSession { session_id } => {
            let _ = rpc_tx.try_send(RpcCommand::StopSession { session_id });
        }
    }
}

/// Key handling for agent selection in start-session wizard.
pub(crate) fn handle_agent_select_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) {
    let count = app.connected_agents().len();
    match key.code {
        KeyCode::Esc => {
            app.input_mode = InputMode::Normal;
        }
        KeyCode::Char('j') | KeyCode::Down => {
            if count > 0 {
                app.start_agent_idx = (app.start_agent_idx + 1).min(count - 1);
            }
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if app.start_agent_idx > 0 {
                app.start_agent_idx -= 1;
            }
        }
        KeyCode::Enter => {
            // Move to project select and trigger ListProjects RPC.
            let connected = app.connected_agents();
            if let Some(agent) = connected.get(app.start_agent_idx) {
                let agent_name = agent.info.name.clone();
                let _ = rpc_tx.try_send(RpcCommand::ListProjects { agent_name });
            }
            app.input_mode = InputMode::StartSessionProjectSelect;
        }
        _ => {}
    }
}

/// Key handling for project selection in start-session wizard.
pub(crate) fn handle_project_select_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) {
    match key.code {
        KeyCode::Esc => {
            app.input_mode = InputMode::Normal;
            app.start_project.clear();
            app.start_cwd.clear();
            app.start_projects.clear();
            app.start_project_filter.clear();
        }
        KeyCode::Char('j') | KeyCode::Down => {
            let count = app.filtered_projects().len();
            if count > 0 {
                app.start_project_idx = (app.start_project_idx + 1).min(count - 1);
            }
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if app.start_project_idx > 0 {
                app.start_project_idx -= 1;
            }
        }
        KeyCode::Enter => {
            let filtered = app.filtered_projects();
            if let Some(project) = filtered.get(app.start_project_idx).cloned().cloned() {
                app.start_project = project.clone();
                // Source CWD from agent project data when available.
                app.start_cwd = app
                    .project_details_map
                    .get(&project)
                    .and_then(|d| d.path.clone())
                    .unwrap_or_else(|| format!("~/dev/{project}"));
                app.start_projects.clear();
                app.start_project_filter.clear();
                app.input_mode = InputMode::StartSessionCwd;
            }
        }
        KeyCode::Backspace => {
            app.start_project_filter.pop();
            app.start_project_idx = 0;
        }
        KeyCode::Char(c) => {
            // j/k are handled above for navigation; all other chars filter.
            // (j/k are caught by the KeyCode::Char('j') | KeyCode::Char('k') arms above.)
            app.start_project_filter.push(c);
            app.start_project_idx = 0;
        }
        _ => {}
    }
    // Suppress unused variable warning — rpc_tx reserved for future use.
    let _ = rpc_tx;
}

/// Key handling for cwd text input in the start-session wizard.
pub(crate) fn handle_cwd_input_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) {
    match key.code {
        KeyCode::Esc => {
            app.input_mode = InputMode::Normal;
            app.start_project.clear();
            app.start_cwd.clear();
        }
        KeyCode::Backspace => {
            app.start_cwd.pop();
        }
        KeyCode::Char(c) => {
            app.start_cwd.push(c);
        }
        KeyCode::Enter => {
            // Submit: send RPC.
            let connected = app.connected_agents();
            let agent_name = connected
                .get(app.start_agent_idx)
                .map(|a| a.info.name.clone())
                .unwrap_or_default();
            let project = app.start_project.clone();
            let cwd = app.start_cwd.clone();

            let _ = rpc_tx.try_send(RpcCommand::StartSession {
                agent_name,
                project,
                cwd,
            });

            app.status_message = Some("starting session...".to_string());
            // Stay in current mode until we get the result.
            app.input_mode = InputMode::Normal;
            app.start_project.clear();
            app.start_cwd.clear();
        }
        _ => {}
    }
}
