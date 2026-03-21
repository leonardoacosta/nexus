use std::io;
use std::time::Duration;

use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use tokio::sync::mpsc;

mod app;
mod client;
mod notifications;
mod screens;
mod stream;

use app::{AgentData, App, InputMode, PaletteAction, Screen};
use client::{ConnectionStatus, NexusClient};
use nexus_core::config::NexusConfig;
use stream::{AlertEvent, StreamLine};

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
}

enum RpcResult {
    StartOk(String),
    StartErr(String),
    StopOk,
    StopErr(String),
    CommandOutput(nexus_core::proto::CommandOutput),
    CommandStreamDone,
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
    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    crossterm::execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // Channel for background poll results.
    let (poll_tx, mut poll_rx) = mpsc::channel::<Vec<AgentData>>(4);

    // Channel for RPC commands from the event loop.
    let (rpc_tx, rpc_rx) = mpsc::channel::<RpcCommand>(4);
    let (rpc_result_tx, mut rpc_result_rx) = mpsc::channel::<RpcResult>(4);

    // Move client into the background task that handles both polling and RPCs.
    tokio::spawn(background_task(client, poll_tx, rpc_rx, rpc_result_tx));

    // Start background alert stream for notifications.
    let mut alert_rx = stream::subscribe_alert_stream(&agent_endpoints);

    // Channel for stream attach events (created on demand, reused here as Option).
    let mut stream_rx: Option<mpsc::Receiver<StreamLine>> = None;

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
    terminal::disable_raw_mode()?;
    crossterm::execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

/// The main render + event loop.
#[allow(clippy::too_many_arguments)]
fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    poll_rx: &mut mpsc::Receiver<Vec<AgentData>>,
    rpc_tx: &mpsc::Sender<RpcCommand>,
    rpc_result_rx: &mut mpsc::Receiver<RpcResult>,
    alert_rx: &mut mpsc::Receiver<AlertEvent>,
    stream_rx: &mut Option<mpsc::Receiver<StreamLine>>,
    agent_endpoints: &[(String, u16)],
) -> Result<()> {
    loop {
        // Render.
        terminal.draw(|frame| {
            // Always render the base screen first.
            match app.current_screen {
                Screen::Dashboard => screens::dashboard::render_dashboard(frame, app),
                Screen::Detail => screens::detail::render_detail(frame, app),
                Screen::Health => screens::health::render_health(frame, app),
                Screen::Projects => screens::projects::render_projects(frame, app),
                Screen::Palette => {
                    // Render dashboard underneath, then overlay palette.
                    screens::dashboard::render_dashboard(frame, app);
                    screens::palette::render_palette(frame, app);
                }
                Screen::StreamAttach => screens::stream::render_stream(frame, app),
            }

            // Start session wizard overlays on top of whatever screen.
            if matches!(
                app.input_mode,
                InputMode::StartSessionAgent
                    | InputMode::StartSessionProject
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
                    // Ensure input mode stays in StreamInput so user can type next command.
                    if app.current_screen == Screen::StreamAttach {
                        app.input_mode = InputMode::StreamInput;
                    }
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
            while let Ok(line) = rx.try_recv() {
                if let Some(sv) = app.stream_view.as_mut() {
                    sv.push_line(line.text);
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
            ));
        }

        // If we left stream attach, drop the receiver.
        if app.current_screen != Screen::StreamAttach && stream_rx.is_some() {
            *stream_rx = None;
        }

        // Tick notification manager (remove expired).
        app.notifications.tick();

        // Increment frame counter for animations (spinner, etc.).
        app.tick_count = app.tick_count.wrapping_add(1);

        // Poll for keyboard events with 200ms timeout.
        if event::poll(Duration::from_millis(200))?
            && let Event::Key(key) = event::read()?
            && handle_key(app, key, rpc_tx)
        {
            break;
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

/// Handle a key event. Returns true if the app should quit.
fn handle_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> bool {
    // Clear status message and dismiss notifications on any key press.
    app.status_message = None;
    app.notifications.dismiss_all();

    // Ctrl+C always quits.
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        app.should_quit = true;
        return true;
    }

    // Dispatch based on input mode.
    match app.input_mode {
        InputMode::Normal => handle_normal_key(app, key, rpc_tx),
        InputMode::PaletteInput => {
            handle_palette_key(app, key, rpc_tx);
            false
        }
        InputMode::StartSessionAgent => {
            handle_agent_select_key(app, key);
            false
        }
        InputMode::StartSessionProject => {
            handle_text_input_key(app, key, TextInputTarget::Project, rpc_tx);
            false
        }
        InputMode::StartSessionCwd => {
            handle_text_input_key(app, key, TextInputTarget::Cwd, rpc_tx);
            false
        }
        InputMode::StreamInput => {
            match key.code {
                KeyCode::Enter => {
                    if !app.stream_input.is_empty() && !app.stream_executing {
                        let prompt = app.stream_input.clone();
                        app.stream_input.clear();
                        app.stream_executing = true;

                        // Get session ID from stream view and dispatch RPC.
                        if let Some(sv) = &app.stream_view {
                            let session_id = sv.session_id.clone();
                            let _ = rpc_tx.try_send(RpcCommand::SendCommand {
                                session_id,
                                prompt,
                            });
                        }
                    }
                }
                KeyCode::Char(c) => {
                    if !app.stream_executing {
                        app.stream_input.push(c);
                    }
                }
                KeyCode::Backspace => {
                    if !app.stream_executing {
                        app.stream_input.pop();
                    }
                }
                KeyCode::Esc => {
                    // Exit stream input, go back to normal stream view.
                    app.input_mode = InputMode::Normal;
                    app.stream_input.clear();
                }
                _ => {}
            }
            false
        }
    }
}

/// Normal mode key handling.
fn handle_normal_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> bool {
    match app.current_screen {
        Screen::Detail => handle_detail_key(app, key, rpc_tx),
        Screen::StreamAttach => handle_stream_key(app, key),
        _ => handle_list_key(app, key, rpc_tx),
    }
}

/// Key handling for list-based screens (Dashboard, Health, Projects).
fn handle_list_key(app: &mut App, key: KeyEvent, _rpc_tx: &mpsc::Sender<RpcCommand>) -> bool {
    match key.code {
        KeyCode::Char('q') => {
            app.should_quit = true;
            true
        }
        KeyCode::Tab => {
            app.next_screen();
            false
        }
        KeyCode::BackTab => {
            app.prev_screen();
            false
        }
        KeyCode::Char('j') | KeyCode::Down => {
            app.move_down();
            false
        }
        KeyCode::Char('k') | KeyCode::Up => {
            app.move_up();
            false
        }
        KeyCode::Enter => {
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
            false
        }
        KeyCode::Char(':') | KeyCode::Char('/') => {
            app.open_palette();
            false
        }
        KeyCode::Char('n') => {
            if app.current_screen == Screen::Dashboard {
                app.begin_start_session();
            }
            false
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
                    app.input_mode = InputMode::StreamInput;
                }
            }
            false
        }
        KeyCode::Char('A') => {
            app.status_message = Some("use 'a' for interactive stream".to_string());
            false
        }
        _ => false,
    }
}

/// Key handling for the detail screen.
fn handle_detail_key(app: &mut App, key: KeyEvent, rpc_tx: &mpsc::Sender<RpcCommand>) -> bool {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.close_detail();
            false
        }
        KeyCode::Char('s') => {
            // Stop the currently viewed session.
            if let Some((session, _)) = &app.selected_session {
                let id = session.id.clone();
                let _ = rpc_tx.try_send(RpcCommand::StopSession { session_id: id });
            }
            false
        }
        _ => false,
    }
}

/// Key handling for the stream attach view.
fn handle_stream_key(app: &mut App, key: KeyEvent) -> bool {
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => {
            app.close_stream_attach();
            false
        }
        KeyCode::Char('j') | KeyCode::Down => {
            if let Some(sv) = app.stream_view.as_mut() {
                // Use a reasonable default visible height; actual height is
                // only known at render time. 20 is a safe lower bound.
                sv.scroll_down(20);
            }
            false
        }
        KeyCode::Char('k') | KeyCode::Up => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.scroll_up();
            }
            false
        }
        KeyCode::PageUp => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.page_up(20);
            }
            false
        }
        KeyCode::PageDown => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.page_down(20);
            }
            false
        }
        KeyCode::End => {
            if let Some(sv) = app.stream_view.as_mut() {
                sv.scroll_to_end();
            }
            false
        }
        KeyCode::Char('i') => {
            app.input_mode = InputMode::StreamInput;
            false
        }
        _ => false,
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
            app.begin_start_session();
        }
        PaletteAction::StopSession { session_id } => {
            let _ = rpc_tx.try_send(RpcCommand::StopSession { session_id });
        }
    }
}

/// Key handling for agent selection in start-session wizard.
fn handle_agent_select_key(app: &mut App, key: KeyEvent) {
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
            // Move to project input.
            app.input_mode = InputMode::StartSessionProject;
        }
        _ => {}
    }
}

enum TextInputTarget {
    Project,
    Cwd,
}

/// Key handling for text input fields in the start-session wizard.
fn handle_text_input_key(
    app: &mut App,
    key: KeyEvent,
    target: TextInputTarget,
    rpc_tx: &mpsc::Sender<RpcCommand>,
) {
    match key.code {
        KeyCode::Esc => {
            app.input_mode = InputMode::Normal;
            app.start_project.clear();
            app.start_cwd.clear();
        }
        KeyCode::Backspace => match target {
            TextInputTarget::Project => {
                app.start_project.pop();
            }
            TextInputTarget::Cwd => {
                app.start_cwd.pop();
            }
        },
        KeyCode::Char(c) => match target {
            TextInputTarget::Project => app.start_project.push(c),
            TextInputTarget::Cwd => app.start_cwd.push(c),
        },
        KeyCode::Enter => {
            match target {
                TextInputTarget::Project => {
                    // Default cwd based on project.
                    if app.start_cwd.is_empty() {
                        app.start_cwd = format!("~/dev/{}", app.start_project);
                    }
                    app.input_mode = InputMode::StartSessionCwd;
                }
                TextInputTarget::Cwd => {
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
            }
        }
        _ => {}
    }
}

/// Background task: polls agents periodically and handles RPC commands.
async fn background_task(
    mut client: NexusClient,
    poll_tx: mpsc::Sender<Vec<AgentData>>,
    mut rpc_rx: mpsc::Receiver<RpcCommand>,
    rpc_result_tx: mpsc::Sender<RpcResult>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(2));

    loop {
        tokio::select! {
            _ = interval.tick() => {
                let results = client.get_sessions().await;
                let data = results_to_agent_data(&client, &results);
                if poll_tx.send(data).await.is_err() {
                    break;
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
                            connected: conn.status == ConnectionStatus::Connected,
                        },
                        Vec::new(),
                    )
                });

            AgentData {
                info,
                sessions,
                connected: conn.status == ConnectionStatus::Connected,
                last_seen: conn.last_seen,
                last_error: conn.last_error.clone(),
            }
        })
        .collect()
}
