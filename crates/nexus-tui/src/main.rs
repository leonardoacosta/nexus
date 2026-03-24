use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::execute;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use notify::{EventKind, RecursiveMode, Watcher};
use ratatui::DefaultTerminal;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::Tabs;
use tokio::sync::mpsc;

mod app;
mod client;
mod markdown;
mod notifications;
mod screens;
mod stream;

use app::{
    AgentData, App, InputMode, LineStyle, PaletteAction, Screen, SearchState, Severity,
    StreamVerbosity, StyledLine,
};
use client::{ConnectionStatus, NexusClient};
use nexus_core::config::NexusConfig;
use stream::{AlertEvent, StreamMessage};

// ---------------------------------------------------------------------------
// Key handler return value
// ---------------------------------------------------------------------------

/// The result of processing a single key event.
enum KeyAction {
    /// Continue the event loop normally.
    Continue,
    /// The app should quit.
    Quit,
    /// Open `$EDITOR` (or fallback) with a temp file; send the result as a
    /// prompt when the editor exits.  The caller must handle terminal teardown
    /// and restoration.
    OpenEditor,
}

// ---------------------------------------------------------------------------
// RPC commands sent from the event handler to the async runtime
// ---------------------------------------------------------------------------

enum RpcCommand {
    StartSession {
        agent_name: String,
        project: String,
        cwd: String,
    },
    StopSession {
        session_id: String,
    },
    SendCommand {
        session_id: String,
        prompt: String,
    },
    ListProjects {
        agent_name: String,
    },
}

enum RpcResult {
    StartOk(String),
    StartErr(String),
    StopOk,
    StopErr(String),
    CommandOutput(nexus_core::proto::CommandOutput),
    CommandStreamDone,
    ProjectList(Vec<String>),
    /// One or more agents reconnected successfully.
    AgentsReconnected(Vec<String>),
    /// agents.toml was modified on disk; carries the new agent count.
    ConfigChanged(usize),
}

#[tokio::main]
async fn main() -> Result<()> {
    // Load configuration.
    let config = NexusConfig::load().map_err(|e| {
        anyhow::anyhow!(
            "Failed to load config from {}: {e}",
            NexusConfig::config_path().display()
        )
    })?;

    // Create gRPC client and attempt initial connections.
    let mut client = NexusClient::new(config);
    client.connect_all().await;

    // Do an initial poll so the TUI has data on first render.
    let initial_results = client.get_sessions().await;
    let initial_data = results_to_agent_data(&client, &initial_results);

    // Collect agent endpoints for streaming connections.
    let agent_endpoints: Vec<(String, u16)> = client
        .agents
        .iter()
        .map(|a| (a.config.host.clone(), a.config.port))
        .collect();

    let mut app = App::new();
    app.update_agents(initial_data);

    // Set up terminal.
    let mut terminal = ratatui::try_init()?;
    execute!(std::io::stdout(), EnableMouseCapture)?;

    // Channel for background poll results.
    let (poll_tx, mut poll_rx) = mpsc::channel::<Vec<AgentData>>(4);

    // Channel for RPC commands from the event loop.
    let (rpc_tx, rpc_rx) = mpsc::channel::<RpcCommand>(4);
    let (rpc_result_tx, mut rpc_result_rx) = mpsc::channel::<RpcResult>(4);

    // Move client into the background task that handles both polling and RPCs.
    tokio::spawn(background_task(client, poll_tx, rpc_rx, rpc_result_tx.clone()));

    // Watch agents.toml for live edits.
    spawn_config_watcher(NexusConfig::config_path(), rpc_result_tx);

    // Start background alert stream for notifications.
    let mut alert_rx = stream::subscribe_alert_stream(&agent_endpoints);

    // Channel for stream attach events (created on demand, reused here as Option).
    let mut stream_rx: Option<mpsc::Receiver<StreamMessage>> = None;

    // Main event loop.
    let result = run_loop(
        &mut terminal,
        &mut app,
        &mut poll_rx,
        &rpc_tx,
        &mut rpc_result_rx,
        &mut alert_rx,
        &mut stream_rx,
        &agent_endpoints,
    );

    // Restore terminal.
    execute!(std::io::stdout(), DisableMouseCapture)?;
    ratatui::restore();

    result
}

/// The main render + event loop.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    terminal: &mut DefaultTerminal,
    app: &mut App,
    poll_rx: &mut mpsc::Receiver<Vec<AgentData>>,
    rpc_tx: &mpsc::Sender<RpcCommand>,
    rpc_result_rx: &mut mpsc::Receiver<RpcResult>,
    alert_rx: &mut mpsc::Receiver<AlertEvent>,
    stream_rx: &mut Option<mpsc::Receiver<StreamMessage>>,
    agent_endpoints: &[(String, u16)],
) -> Result<()> {
    loop {
        // Render.
        terminal.draw(|frame| {
            let full_area = frame.area();

            // Split: 2-row Tabs bar at top, rest goes to the active screen.
            let [tabs_area, content_area] = Layout::vertical([
                Constraint::Length(2),
                Constraint::Min(0),
            ])
            .areas(full_area);

            // Render the Tabs widget (only for the 3 primary tab screens).
            render_tabs(frame, tabs_area, app);

            // Always render the base screen first.
            match app.current_screen {
                Screen::Dashboard => screens::dashboard::render_dashboard(frame, content_area, app),
                Screen::Detail => screens::detail::render_detail(frame, content_area, app),
                Screen::Health => screens::health::render_health(frame, content_area, app),
                Screen::Projects => screens::projects::render_projects(frame, content_area, app),
                Screen::Palette => {
                    // Render dashboard underneath, then overlay palette.
                    screens::dashboard::render_dashboard(frame, content_area, app);
                    screens::palette::render_palette(frame, app);
                }
                Screen::StreamAttach => screens::stream::render_stream(frame, content_area, app),
            }

            // Scratchpad overlay on Projects screen.
            if app.current_screen == Screen::Projects && app.input_mode == InputMode::ScratchpadEdit
            {
                screens::projects::render_scratchpad(frame, app);
            }

            // Start session wizard overlays on top of whatever screen.
            if matches!(
                app.input_mode,
                InputMode::StartSessionAgent
                    | InputMode::StartSessionProjectSelect
                    | InputMode::StartSessionCwd
            ) {
                screens::palette::render_start_session(frame, app);
            }

            // Render notification overlay on status bar (bottom row).
            if app.notifications.latest().is_some() {
                let area = frame.area();
                let status_area = ratatui::layout::Rect {
                    x: area.x,
                    y: area.y + area.height.saturating_sub(1),
                    width: area.width,
                    height: 1,
                };
                notifications::render_notification(frame, status_area, &app.notifications);
            }
        })?;

        // Check for agent data updates (non-blocking).
        while let Ok(data) = poll_rx.try_recv() {
            app.update_agents(data);
        }

        // Check for RPC results (non-blocking).
        while let Ok(result) = rpc_result_rx.try_recv() {
            match result {
                RpcResult::StartOk(id) => {
                    app.status_message =
                        Some(format!("started session {}", &id[..8.min(id.len())]));
                    app.input_mode = InputMode::Normal;
                    app.current_screen = Screen::Dashboard;
                }
                RpcResult::StartErr(e) => {
                    app.status_message = Some(format!("start failed: {e}"));
                    app.input_mode = InputMode::Normal;
                }
                RpcResult::StopOk => {
                    app.status_message = Some("session stopped".to_string());
                    app.close_detail();
                }
                RpcResult::StopErr(e) => {
                    app.status_message = Some(format!("stop failed: {e}"));
                }
                RpcResult::CommandOutput(output) => {
                    if let Some(sv) = &mut app.stream_view {
                        sv.push_command_output(&output);
                    }
                }
                RpcResult::CommandStreamDone => {
                    app.stream_executing = false;
                    app.stream_exec_start = None;
                    // Ensure input mode stays in StreamInput so user can type next command.
                    if app.current_screen == Screen::StreamAttach {
                        app.input_mode = InputMode::StreamInput;
                    }
                }
                RpcResult::ProjectList(projects) => {
                    app.start_projects = projects;
                    app.start_project_idx = 0;
                    app.start_project_filter.clear();
                }
                RpcResult::AgentsReconnected(names) => {
                    for name in names {
                        app.notifications.push(
                            format!("\u{2713} reconnected to {name}"),
                            Severity::Info,
                        );
                    }
                }
                RpcResult::ConfigChanged(n) => {
                    app.notifications.push(
                        format!("config reloaded: {n} agents"),
                        Severity::Info,
                    );
                }
            }
        }

        // Check for alert notifications (non-blocking).
        while let Ok(alert) = alert_rx.try_recv() {
            // Try to resolve project name from current session data.
            let project = app
                .all_sessions()
                .iter()
                .find(|r| r.session.id == alert.session_id)
                .and_then(|r| r.session.project.clone());

            if let Some((message, severity)) = notifications::format_status_notification(
                &alert.session_id,
                project.as_deref(),
                alert.new_status,
            ) {
                app.notifications.push(message, severity);
            }
        }

        // Check for stream attach events (non-blocking).
        if let Some(rx) = stream_rx.as_mut() {
            while let Ok(msg) = rx.try_recv() {
                match msg {
                    StreamMessage::Line(line) => {
                        if let Some(sv) = app.stream_view.as_mut() {
                            sv.push_line(StyledLine::new(line.text, LineStyle::Plain));
                        }
                    }
                    StreamMessage::SessionMeta {
                        session_type,
                        status: _,
                    } => {
                        if let Some(sv) = app.stream_view.as_mut() {
                            // Debounce: skip if same status text within 5 seconds.
                            let debounced =
                                sv.last_status_event.as_ref().is_some_and(|(text, ts)| {
                                    text == &session_type
                                        && ts.elapsed() < std::time::Duration::from_secs(5)
                                });
                            if !debounced {
                                sv.last_status_event =
                                    Some((session_type.clone(), std::time::Instant::now()));
                                sv.system_event_count += 1;
                            }
                            sv.session_type = Some(session_type);
                        }
                    }
                    StreamMessage::Heartbeat { timestamp } => {
                        if let Some(sv) = app.stream_view.as_mut() {
                            let was_alive = sv.heartbeat_alive;
                            sv.last_heartbeat_ts = Some(timestamp.clone());
                            sv.last_heartbeat_tick = app.tick_count;
                            sv.system_event_count += 1;
                            if !was_alive {
                                // Heartbeat resumed after being stale.
                                sv.push_line(StyledLine::new(
                                    format!("\u{2713} heartbeat resumed at {timestamp}"),
                                    LineStyle::DoneSummary,
                                ));
                            }
                            sv.heartbeat_alive = true;
                        }
                    }
                    StreamMessage::AgentGoingAway { agent_name, reason } => {
                        // Mark the agent as reconnecting in the app data so the
                        // status bar updates immediately (next poll will reconcile).
                        if let Some(agent) = app.agents.iter_mut().find(|a| a.info.name == agent_name) {
                            agent.connected = false;
                            agent.reconnect_attempt = Some(0);
                        }
                        // Notify the user in the stream view.
                        if let Some(sv) = app.stream_view.as_mut() {
                            sv.push_line(StyledLine::new(
                                format!("\u{26A0} agent shutting down ({reason}), reconnecting..."),
                                LineStyle::Error,
                            ));
                        }
                    }
                }
            }
        }

        // If we just opened a stream attach but don't have a receiver yet, create one.
        // Connect only to the agent that owns the session, not all agents.
        if app.current_screen == Screen::StreamAttach
            && stream_rx.is_none()
            && let Some(sv) = &app.stream_view
        {
            let target_endpoint: Option<(String, u16)> = app
                .agents
                .iter()
                .find(|a| a.info.name == sv.agent_name)
                .map(|a| (a.info.host.clone(), a.info.port));

            let endpoints = match target_endpoint {
                Some(ep) => vec![ep],
                None => {
                    tracing::warn!(agent = %sv.agent_name, "stream: owning agent not found, trying all");
                    agent_endpoints.to_vec()
                }
            };

            *stream_rx = Some(stream::subscribe_session_stream(
                &endpoints,
                sv.session_id.clone(),
                sv.agent_name.clone(),
            ));
        }

        // If we left stream attach, drop the receiver.
        if app.current_screen != Screen::StreamAttach && stream_rx.is_some() {
            *stream_rx = None;
        }

        // Tick notification manager (remove expired).
        app.notifications.tick();

        // Tick stream view notification (dismiss after ~15 ticks / ~3 seconds).
        if let Some(sv) = app.stream_view.as_mut()
            && let Some((_, ref mut age)) = sv.notification_message
        {
            *age += 1;
            if *age > 15 {
                sv.notification_message = None;
            }
        }

        // Increment frame counter for animations (spinner, etc.).
        app.tick_count = app.tick_count.wrapping_add(1);

        // Heartbeat staleness check: if alive but no heartbeat for ~10 seconds
        // (>50 ticks at ~5 ticks/sec), mark stale and emit a warning line.
        if let Some(sv) = app.stream_view.as_mut()
            && sv.heartbeat_alive
            && app.tick_count.wrapping_sub(sv.last_heartbeat_tick) > 50
        {
            sv.heartbeat_alive = false;
            sv.system_event_count += 1;
            let ts = sv
                .last_heartbeat_ts
                .clone()
                .unwrap_or_else(|| "??:??:??".to_string());
            sv.push_line(StyledLine::new(
                format!("\u{26A0} heartbeat lost at {ts}"),
                LineStyle::Error,
            ));
        }

        // Poll for keyboard and mouse events with 200ms timeout.
        if event::poll(Duration::from_millis(200))? {
            match event::read()? {
                Event::Key(key) => match handle_key(app, key, rpc_tx) {
                    KeyAction::Quit => break,
                    KeyAction::OpenEditor => {
                        launch_editor(terminal, app, rpc_tx)?;
                    }
                    KeyAction::Continue => {}
                },
                Event::Mouse(mouse) => {
                    handle_mouse(app, mouse);
                }
                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

/// Leave alternate screen, spawn $EDITOR (with vi/nano fallback) on a temp
/// file, read the result, re-enter alternate screen, then send the prompt.
fn launch_editor(
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
    std::fs::write(&tmp_path, &app.stream_input)?;

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

    // Send the prompt.
    app.stream_input.clear();
    app.stream_executing = true;
    app.stream_exec_start = Some(std::time::Instant::now());

    if let Some(sv) = &mut app.stream_view {
        sv.push_history(prompt.clone());
        sv.push_line(StyledLine::new(
            "\u{2500}\u{2500} you \u{2500}\u{2500}",
            LineStyle::UserHeader,
        ));
        for line in prompt.lines() {
            sv.push_line(StyledLine::new(line.to_string(), LineStyle::UserPrompt));
        }
        // Blank separator after user prompt block.
        sv.push_line(StyledLine::new("", LineStyle::Plain));
        // Reset assistant header for the upcoming response.
        sv.assistant_header_emitted = false;
    }

    if let Some(sv) = &app.stream_view {
        let session_id = sv.session_id.clone();
        let _ = rpc_tx.try_send(RpcCommand::SendCommand { session_id, prompt });
    }

    Ok(())
}

/// Render the tab bar showing Dashboard / Health / Projects.
///
/// The active tab is highlighted with an underline. Detail, Palette, and
/// StreamAttach are not shown as tabs (they are transient screens).
fn render_tabs(frame: &mut ratatui::Frame, area: ratatui::layout::Rect, app: &App) {
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
fn which_bin(bin: &str) -> Option<String> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(bin).exists()))
        .and_then(|found| if found { Some(bin.to_string()) } else { None })
}

/// Handle a key event. Returns the appropriate `KeyAction`.
fn handle_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> KeyAction {
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
    }
}

/// Key handling for the stream input bar.
///
/// - Enter (without Shift): send the buffer as a prompt.
/// - Shift+Enter or Ctrl+J: insert newline.
/// - Ctrl+E: open external editor.
/// - Up/Down: navigate history (only when input is empty).
/// - Backspace: delete last character.
/// - Esc: exit stream input mode.
/// - Any other char: append to buffer.
fn handle_stream_input_key(
    app: &mut App,
    key: KeyEvent,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) -> KeyAction {
    // All input is blocked while a command is executing, except Esc.
    if app.stream_executing {
        if key.code == KeyCode::Esc {
            app.input_mode = InputMode::Normal;
            app.stream_input.clear();
        }
        return KeyAction::Continue;
    }

    // Ctrl+E — open external editor.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('e') {
        return KeyAction::OpenEditor;
    }

    // Ctrl+J — insert newline (alternative to Shift+Enter).
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('j') {
        app.stream_input.push('\n');
        // Reset history navigation when editing.
        if let Some(sv) = &mut app.stream_view {
            sv.history_index = None;
        }
        return KeyAction::Continue;
    }

    match key.code {
        // Shift+Enter inserts a newline into the buffer.
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
            app.stream_input.push('\n');
            if let Some(sv) = &mut app.stream_view {
                sv.history_index = None;
            }
        }

        // Plain Enter sends the buffer.
        KeyCode::Enter => {
            if !app.stream_input.is_empty() {
                let prompt = app.stream_input.clone();
                app.stream_input.clear();
                app.stream_executing = true;
                app.stream_exec_start = Some(std::time::Instant::now());

                if let Some(sv) = &mut app.stream_view {
                    sv.push_history(prompt.clone());
                    sv.push_line(StyledLine::new(
                        "\u{2500}\u{2500} you \u{2500}\u{2500}",
                        LineStyle::UserHeader,
                    ));
                    for line in prompt.lines() {
                        sv.push_line(StyledLine::new(line.to_string(), LineStyle::UserPrompt));
                    }
                    // Blank separator after user prompt block.
                    sv.push_line(StyledLine::new("", LineStyle::Plain));
                    // Reset assistant header for the upcoming response.
                    sv.assistant_header_emitted = false;
                }

                if let Some(sv) = &app.stream_view {
                    let session_id = sv.session_id.clone();
                    let _ = rpc_tx.try_send(RpcCommand::SendCommand { session_id, prompt });
                }
            }
        }

        // Up — navigate backward in history (only when input is empty).
        KeyCode::Up if app.stream_input.is_empty() => {
            if let Some(sv) = &mut app.stream_view {
                if sv.input_history.is_empty() {
                    return KeyAction::Continue;
                }
                let new_idx = match sv.history_index {
                    None => sv.input_history.len() - 1,
                    Some(0) => 0,
                    Some(i) => i - 1,
                };
                sv.history_index = Some(new_idx);
                app.stream_input = sv.input_history[new_idx].clone();
            }
        }

        // Down — navigate forward in history (only when input is empty or navigating).
        KeyCode::Down => {
            if let Some(sv) = &mut app.stream_view {
                match sv.history_index {
                    None => {} // Not navigating; do nothing.
                    Some(i) if i + 1 >= sv.input_history.len() => {
                        // Past the end: clear input and exit history navigation.
                        sv.history_index = None;
                        app.stream_input.clear();
                    }
                    Some(i) => {
                        let new_idx = i + 1;
                        sv.history_index = Some(new_idx);
                        app.stream_input = sv.input_history[new_idx].clone();
                    }
                }
            }
        }

        KeyCode::Char(c) => {
            app.stream_input.push(c);
            // Any typing exits history navigation.
            if let Some(sv) = &mut app.stream_view {
                sv.history_index = None;
            }
        }

        KeyCode::Backspace => {
            app.stream_input.pop();
            // Backspace also exits history navigation.
            if let Some(sv) = &mut app.stream_view {
                sv.history_index = None;
            }
        }

        KeyCode::Esc => {
            // Exit stream input, go back to normal stream view.
            app.input_mode = InputMode::Normal;
            app.stream_input.clear();
            if let Some(sv) = &mut app.stream_view {
                sv.history_index = None;
            }
        }

        _ => {}
    }

    KeyAction::Continue
}

/// Handle mouse events (scroll wheel for navigation).
fn handle_mouse(app: &mut App, mouse: crossterm::event::MouseEvent) {
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

/// Normal mode key handling.
fn handle_normal_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> KeyAction {
    match app.current_screen {
        Screen::Detail => handle_detail_key(app, key, rpc_tx),
        Screen::StreamAttach => handle_stream_key(app, key),
        _ => handle_list_key(app, key, rpc_tx),
    }
}

/// Key handling for list-based screens (Dashboard, Health, Projects).
fn handle_list_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> KeyAction {
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
            if app.current_screen == Screen::Dashboard {
                let sessions = app.all_sessions();
                if let Some(row) = sessions.get(app.selected_index) {
                    let session = row.session.clone();
                    // Find the agent info.
                    let agent_info = app
                        .agents
                        .iter()
                        .find(|a| a.info.name == row.agent_name)
                        .map(|a| a.info.clone())
                        .unwrap_or_else(|| nexus_core::agent::AgentInfo {
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
            }
            KeyAction::Continue
        }
        KeyCode::Char(':') | KeyCode::Char('/') => {
            app.open_palette();
            KeyAction::Continue
        }
        KeyCode::Char('n') => {
            if app.current_screen == Screen::Dashboard
                && let Some(agent_name) = app.begin_start_session()
            {
                let _ = rpc_tx.try_send(RpcCommand::ListProjects { agent_name });
            }
            KeyAction::Continue
        }
        KeyCode::Char('a') => {
            // Stream attach: works for all sessions (managed and ad-hoc).
            if app.current_screen == Screen::Dashboard {
                let sessions = app.all_sessions();
                if let Some(row) = sessions.get(app.selected_index) {
                    let session_id = row.session.id.clone();
                    let agent_name = row.agent_name.clone();
                    let project = row.session.project.as_deref().unwrap_or("?");
                    let short_id = &session_id[..session_id.len().min(4)];
                    let label = format!("{project}#{short_id}");
                    app.open_stream_attach(session_id, label, agent_name);
                    app.ensure_session_tab();
                    app.input_mode = InputMode::StreamInput;
                }
            }
            KeyAction::Continue
        }
        KeyCode::Char('e') => {
            // Open scratchpad for selected project on Projects screen.
            if app.current_screen == Screen::Projects {
                let summaries = app.project_summaries();
                if let Some(p) = summaries.get(app.selected_index) {
                    let name = p.name.clone();
                    app.open_scratchpad(&name);
                }
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
fn handle_detail_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> KeyAction {
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

/// Key handling for the stream attach view.
fn handle_stream_key(app: &mut App, key: KeyEvent) -> KeyAction {
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
fn yank_code_block(app: &mut App) {
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
fn search_next(app: &mut App) {
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
fn search_prev(app: &mut App) {
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
fn switch_session_tab(app: &mut App, tab_idx: usize) {
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
fn handle_stream_search_key(app: &mut App, key: KeyEvent) {
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

/// Key handling for the palette input mode.
fn handle_palette_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) {
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
        KeyCode::Char('j') | KeyCode::Down => {
            if !app.palette_results.is_empty() {
                app.palette_selected =
                    (app.palette_selected + 1).min(app.palette_results.len() - 1);
            }
        }
        KeyCode::Char('k') | KeyCode::Up => {
            // In palette input, only arrow keys navigate (j/k are typing chars).
            // So we only handle Up here.
            if key.code == KeyCode::Up && app.palette_selected > 0 {
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
fn execute_palette_action(app: &mut App, action: PaletteAction, rpc_tx: &mpsc::Sender<RpcCommand>) {
    match action {
        PaletteAction::GoSession {
            session_id,
            agent_name,
        } => {
            // Find the session and agent info from current state.
            let sessions = app.all_sessions();
            if let Some(row) = sessions.iter().find(|r| r.session.id == session_id) {
                let session = row.session.clone();
                let agent_info = app
                    .agents
                    .iter()
                    .find(|a| a.info.name == agent_name)
                    .map(|a| a.info.clone())
                    .unwrap_or_else(|| nexus_core::agent::AgentInfo {
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
fn handle_agent_select_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) {
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
fn handle_project_select_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) {
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
                app.start_cwd = format!("~/dev/{project}");
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
fn handle_cwd_input_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) {
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

/// Background task: polls agents periodically and handles RPC commands.
/// Spawn a background task that watches `~/.config/nexus/agents.toml` for
/// modifications.  On each write event (debounced 500 ms) the file is
/// re-parsed and the new agent count is sent as `RpcResult::ConfigChanged`.
fn spawn_config_watcher(config_path: PathBuf, result_tx: mpsc::Sender<RpcResult>) {
    // Bridge: notify fires on a OS thread; we forward events into a tokio channel.
    let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);

    // `_watcher` must stay alive for the watch to remain active.
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res
            && matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_))
        {
            // Best-effort send; drop duplicate events that back up while
            // the debounce window is active.
            let _ = notify_tx.try_send(());
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            tracing::warn!("config watcher: failed to create watcher: {e}");
            return;
        }
    };

    if let Err(e) = watcher.watch(&config_path, RecursiveMode::NonRecursive) {
        tracing::warn!(path = %config_path.display(), "config watcher: failed to watch: {e}");
        return;
    }

    tokio::spawn(async move {
        // Keep watcher alive inside the async task.
        let _watcher = watcher;

        loop {
            // Wait for the next raw event.
            if notify_rx.recv().await.is_none() {
                break;
            }

            // Debounce: drain any additional events that arrive within 500 ms.
            let debounce = tokio::time::sleep(Duration::from_millis(500));
            tokio::pin!(debounce);
            loop {
                tokio::select! {
                    _ = &mut debounce => break,
                    extra = notify_rx.recv() => {
                        if extra.is_none() {
                            return;
                        }
                        // Another event arrived — reset the debounce window.
                        debounce.as_mut().reset(
                            tokio::time::Instant::now() + Duration::from_millis(500),
                        );
                    }
                }
            }

            // Re-parse the config and report the result.
            // Extract the outcome before any `.await` so the non-Send error
            // type is not held across an await point.
            let reload_outcome: Option<usize> =
                match nexus_core::config::NexusConfig::load() {
                    Ok(cfg) => {
                        let n = cfg.agents.len();
                        tracing::info!("config reloaded: {n} agents");
                        Some(n)
                    }
                    Err(e) => {
                        tracing::warn!("config watcher: reload failed: {e}");
                        None
                    }
                };

            if let Some(n) = reload_outcome {
                let _ = result_tx.send(RpcResult::ConfigChanged(n)).await;
            }
        }
    });
}

async fn background_task(
    mut client: NexusClient,
    poll_tx: mpsc::Sender<Vec<AgentData>>,
    mut rpc_rx: mpsc::Receiver<RpcCommand>,
    rpc_result_tx: mpsc::Sender<RpcResult>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    // Reconnect attempts use a separate slower interval (5s baseline).
    let mut reconnect_interval = tokio::time::interval(Duration::from_secs(5));
    // Skip the immediate first tick so reconnects don't race with connect_all.
    reconnect_interval.reset();

    loop {
        tokio::select! {
            _ = interval.tick() => {
                let results = client.get_sessions().await;
                let data = results_to_agent_data(&client, &results);
                if poll_tx.send(data).await.is_err() {
                    break;
                }
            }
            _ = reconnect_interval.tick() => {
                let reconnected = client.reconnect_disconnected().await;
                if !reconnected.is_empty() {
                    let _ = rpc_result_tx.send(RpcResult::AgentsReconnected(reconnected)).await;
                    // Immediately send updated session data after reconnect.
                    let results = client.get_sessions().await;
                    let data = results_to_agent_data(&client, &results);
                    let _ = poll_tx.send(data).await;
                }
            }
            cmd = rpc_rx.recv() => {
                match cmd {
                    Some(RpcCommand::StartSession { agent_name, project, cwd }) => {
                        let result = match client.start_session(&agent_name, &project, &cwd).await {
                            Ok(id) => RpcResult::StartOk(id),
                            Err(e) => RpcResult::StartErr(e.to_string()),
                        };
                        let _ = rpc_result_tx.send(result).await;
                    }
                    Some(RpcCommand::StopSession { session_id }) => {
                        let result = match client.stop_session(&session_id).await {
                            Ok(true) => RpcResult::StopOk,
                            Ok(false) => RpcResult::StopErr("agent reported failure".to_string()),
                            Err(e) => RpcResult::StopErr(e.to_string()),
                        };
                        let _ = rpc_result_tx.send(result).await;
                    }
                    Some(RpcCommand::SendCommand { session_id, prompt }) => {
                        match client.send_command(&session_id, &prompt).await {
                            Ok(mut stream) => {
                                loop {
                                    match stream.message().await {
                                        Ok(Some(output)) => {
                                            let _ = rpc_result_tx.send(RpcResult::CommandOutput(output)).await;
                                        }
                                        Ok(None) => {
                                            let _ = rpc_result_tx.send(RpcResult::CommandStreamDone).await;
                                            break;
                                        }
                                        Err(e) => {
                                            tracing::warn!(%e, "send_command stream error");
                                            let _ = rpc_result_tx.send(RpcResult::CommandStreamDone).await;
                                            break;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                tracing::warn!(%e, "send_command failed");
                                let _ = rpc_result_tx.send(RpcResult::CommandStreamDone).await;
                            }
                        }
                    }
                    Some(RpcCommand::ListProjects { agent_name }) => {
                        let projects = match client.list_projects(&agent_name).await {
                            Ok(p) => p,
                            Err(e) => {
                                tracing::warn!(%e, "list_projects failed");
                                Vec::new()
                            }
                        };
                        let _ = rpc_result_tx.send(RpcResult::ProjectList(projects)).await;
                    }
                    None => break,
                }
            }
        }
    }
}

/// Convert get_sessions() results + client connection state into AgentData.
fn results_to_agent_data(
    client: &NexusClient,
    results: &[(
        nexus_core::agent::AgentInfo,
        Vec<nexus_core::session::Session>,
    )],
) -> Vec<AgentData> {
    client
        .agents
        .iter()
        .map(|conn| {
            // Find matching result by agent name.
            let (info, sessions) = results
                .iter()
                .find(|(info, _)| info.name == conn.config.name)
                .cloned()
                .unwrap_or_else(|| {
                    (
                        nexus_core::agent::AgentInfo {
                            name: conn.config.name.clone(),
                            host: conn.config.host.clone(),
                            port: conn.config.port,
                            os: String::new(),
                            sessions: Vec::new(),
                            health: None,
                            connected: matches!(conn.status, ConnectionStatus::Connected),
                        },
                        Vec::new(),
                    )
                });

            let (reconnect_attempt, dns_failure) = match &conn.status {
                ConnectionStatus::Connected => (None, false),
                ConnectionStatus::Reconnecting { attempt } => (Some(*attempt), false),
                ConnectionStatus::Disconnected { reason } => {
                    (None, reason.contains("DNS"))
                }
            };

            AgentData {
                info,
                sessions,
                connected: matches!(conn.status, ConnectionStatus::Connected),
                last_seen: conn.last_seen,
                last_error: conn.last_error.clone(),
                reconnect_attempt,
                dns_failure,
            }
        })
        .collect()
}
