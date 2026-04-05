use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use crossterm::event::{self, Event};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use notify::{EventKind, RecursiveMode, Watcher};
use ratatui::DefaultTerminal;
use ratatui::layout::{Constraint, Layout};
use tokio::sync::mpsc;

mod app;
mod client;
mod keys;
mod markdown;
mod notification;
mod notifications;
mod screens;
mod stream;
mod stream_state;
mod theme;
mod ui_helpers;

use app::{AgentData, App, InputMode, LineStyle, Screen, Severity, StyledLine};
use client::{ConnectionStatus, NexusClient};
use keys::handle_key;
use nexus_core::config::NexusConfig;
use stream::{AlertEvent, StreamMessage};
use ui_helpers::{handle_mouse, launch_editor, render_help_overlay, render_tabs};

// ---------------------------------------------------------------------------
// Named timing constants (~5 ticks/sec at 200ms poll interval)
// ---------------------------------------------------------------------------

/// Debounce window for duplicate session status events in the stream view.
/// At ~5 ticks/sec this corresponds to a 5-second suppression window.
const STATUS_DEBOUNCE_SECS: u64 = 5;

/// Number of ticks before dismissing a stream-view notification overlay.
/// At ~5 ticks/sec this is approximately 3 seconds of display time.
const NOTIFICATION_DISMISS_TICKS: usize = 15;

/// Number of ticks without a heartbeat before marking the stream stale.
/// At ~5 ticks/sec this corresponds to approximately 10 seconds of silence.
const HEARTBEAT_STALE_TICKS: usize = 50;

// ---------------------------------------------------------------------------
// Key handler return value
// ---------------------------------------------------------------------------

/// The result of processing a single key event.
pub(crate) enum KeyAction {
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

#[allow(dead_code)]
pub(crate) enum RpcCommand {
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
    /// Config file changed on disk — carry the new config so the background
    /// task can update the NexusClient agent list.
    ReloadConfig(NexusConfig),
    FetchSessionHistory {
        days: u32,
        project: Option<String>,
    },
    FetchFailureTrends {
        days: u32,
    },
    FetchSpecVelocity {
        days: u32,
        project: Option<String>,
    },
}

pub(crate) enum RpcResult {
    StartOk(String),
    StartErr(String),
    StopOk,
    StopErr(String),
    CommandOutput(nexus_core::proto::CommandOutput),
    CommandStreamDone,
    ProjectList(Vec<String>),
    /// Failed to list projects — carries the error message for display.
    ProjectListErr(String),
    /// Enriched project details fetched from all agents (name -> detail).
    ProjectDetails(std::collections::HashMap<String, app::ProjectDetail>),
    /// One or more agents reconnected successfully.
    AgentsReconnected(Vec<String>),
    /// agents.toml was modified on disk; carries the new agent count and
    /// updated endpoints so the alert stream can be resubscribed.
    ConfigChanged(usize, Vec<(String, u16)>),
    /// Spec list fetched from agent HTTP API.
    SpecList(Vec<app::SpecListEntry>),
    HealthTimeSeries(Vec<(String, Vec<nexus_core::proto::HealthTimeSeriesEntry>)>),
    SessionHistory(Vec<nexus_core::proto::SessionHistoryEntry>),
    FailureTrends(Vec<nexus_core::proto::FailureTrendEntry>, Vec<nexus_core::proto::FailureByTool>),
    SpecVelocity(Vec<nexus_core::proto::SpecVelocityEntry>),
}

#[tokio::main]
async fn main() -> Result<()> {
    // Sentry must be initialized before any other setup — _guard keeps it alive
    let _sentry_guard = {
        let dsn = std::env::var("SENTRY_DSN").unwrap_or_default();
        sentry::init((
            dsn.as_str(),
            sentry::ClientOptions {
                release: sentry::release_name!(),
                environment: std::env::var("SENTRY_ENVIRONMENT")
                    .ok()
                    .map(|s| s.into()),
                ..Default::default()
            },
        ))
    };

    // OTel tracer: only init if OTEL_EXPORTER_OTLP_ENDPOINT is set
    let otel_endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();

    if let Some(ref endpoint) = otel_endpoint {
        use opentelemetry::trace::TracerProvider as _;
        use opentelemetry_otlp::WithExportConfig;

        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()
            .expect("failed to build OTel span exporter");

        let provider = opentelemetry_sdk::trace::TracerProvider::builder()
            .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
            .build();

        let tracer = provider.tracer("nexus_tui");
        opentelemetry::global::set_tracer_provider(provider);

        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("nexus_tui=info".parse().unwrap()))
            .with(tracing_subscriber::fmt::layer())
            .with(tracing_opentelemetry::layer().with_tracer(tracer))
            .init();
    } else {
        tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("nexus_tui=info".parse().unwrap()))
            .with(tracing_subscriber::fmt::layer())
            .init();
    }

    // Load configuration.
    let config = match NexusConfig::load() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(
                "Config load failed ({}): {e}. Starting with no agents.",
                NexusConfig::config_path().display()
            );
            NexusConfig {
                agents: vec![],
                role: nexus_core::config::AgentRole::Primary,
                self_name: None,
                pool: None,
                bind_address: "127.0.0.1".to_string(),
                secret: None,
            }
        }
    };

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
    let (poll_tx, mut poll_rx) = mpsc::channel::<Vec<AgentData>>(16);

    // Channel for RPC commands from the event loop.
    let (rpc_tx, rpc_rx) = mpsc::channel::<RpcCommand>(32);
    let (rpc_result_tx, mut rpc_result_rx) = mpsc::channel::<RpcResult>(32);

    // Move client into the background task that handles both polling and RPCs.
    tokio::spawn(background_task(
        client,
        poll_tx,
        rpc_rx,
        rpc_result_tx.clone(),
    ));

    // Watch agents.toml for live edits.
    spawn_config_watcher(NexusConfig::config_path(), rpc_result_tx, rpc_tx.clone());

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
            let [tabs_area, content_area] =
                Layout::vertical([Constraint::Length(2), Constraint::Min(0)]).areas(full_area);

            // Render the Tabs widget (only for the 3 primary tab screens).
            render_tabs(frame, tabs_area, app);

            // Always render the base screen first.
            match app.current_screen {
                Screen::Dashboard => screens::dashboard::render_dashboard(frame, content_area, app),
                Screen::Detail => screens::detail::render_detail(frame, content_area, app),
                Screen::Health => screens::health::render_health(frame, content_area, app),
                Screen::Projects => screens::projects::render_projects(frame, content_area, app),
                Screen::Specs => screens::specs::render_specs(frame, content_area, app),
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

            // Render notification settings panel overlay (if open).
            if app.input_mode == InputMode::NotificationPanel {
                screens::notifications::render_notification_panel(frame, app);
            }

            // Render help overlay (if open).
            if app.help_overlay {
                render_help_overlay(frame, app);
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
                    let _ = rpc_tx.try_send(RpcCommand::FetchSessionHistory {
                        days: 7,
                        project: None,
                    });
                    let _ = rpc_tx.try_send(RpcCommand::FetchFailureTrends { days: 7 });
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
                RpcResult::ProjectListErr(e) => {
                    app.notifications
                        .push(format!("project list failed: {e}"), Severity::Error);
                }
                RpcResult::ProjectDetails(map) => {
                    // Merge enriched project details into the app state.
                    for (name, detail) in map {
                        app.project_details_map.insert(name, detail);
                    }
                }
                RpcResult::AgentsReconnected(names) => {
                    for name in names {
                        app.notifications
                            .push(format!("\u{2713} reconnected to {name}"), Severity::Info);
                    }
                }
                RpcResult::ConfigChanged(n, new_endpoints) => {
                    app.notifications
                        .push(format!("config reloaded: {n} agents"), Severity::Info);
                    // Resubscribe alert stream to pick up new/changed agents.
                    *alert_rx = stream::subscribe_alert_stream(&new_endpoints);
                }
                RpcResult::SpecList(specs) => {
                    app.pending_spec_count = specs
                        .iter()
                        .filter(|s| s.status == "unread" || s.status == "read")
                        .count();
                    app.cached_specs = specs;
                }
                RpcResult::HealthTimeSeries(data) => {
                    app.update_health_time_series(data);
                }
                RpcResult::SessionHistory(entries) => {
                    app.update_session_history(entries);
                }
                RpcResult::FailureTrends(daily, by_tool) => {
                    app.update_failure_trends(daily, by_tool);
                }
                RpcResult::SpecVelocity(entries) => {
                    app.update_spec_velocity(entries);
                }
            }
        }

        // Check for alert notifications (non-blocking).
        while let Ok(alert) = alert_rx.try_recv() {
            // Try to resolve project name from current session data.
            let project = app
                .cached_sessions()
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
                            // Debounce: skip if same status text within STATUS_DEBOUNCE_SECS.
                            let debounced =
                                sv.last_status_event.as_ref().is_some_and(|(text, ts)| {
                                    text == &session_type
                                        && ts.elapsed() < std::time::Duration::from_secs(STATUS_DEBOUNCE_SECS)
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
                        if let Some(agent) =
                            app.agents.iter_mut().find(|a| a.info.name == agent_name)
                        {
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
                    // Task 1.4: Stream exhausted all reconnect attempts — show error banner.
                    StreamMessage::Disconnected { reason } => {
                        app.notifications.push(
                            format!("\u{26A0} stream disconnected: {reason}"),
                            Severity::Error,
                        );
                        if let Some(sv) = app.stream_view.as_mut() {
                            sv.push_line(StyledLine::new(
                                format!("\u{26A0} stream disconnected: {reason}"),
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

        // Clear expired two-step confirmations (auto-expire after 3s).
        app.clear_expired_confirm();

        // Tick stream view notification (dismiss after NOTIFICATION_DISMISS_TICKS / ~3 seconds).
        if let Some(sv) = app.stream_view.as_mut()
            && let Some((_, ref mut age)) = sv.notification_message
        {
            *age += 1;
            if *age > NOTIFICATION_DISMISS_TICKS {
                sv.notification_message = None;
            }
        }

        // Increment frame counter for animations (spinner, etc.).
        app.tick_count = app.tick_count.wrapping_add(1);

        // Heartbeat staleness check: if alive but no heartbeat for HEARTBEAT_STALE_TICKS
        // (~10 seconds at ~5 ticks/sec), mark stale and emit a warning line.
        if let Some(sv) = app.stream_view.as_mut()
            && sv.heartbeat_alive
            && app.tick_count.wrapping_sub(sv.last_heartbeat_tick) > HEARTBEAT_STALE_TICKS
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
                // Task 1.2: Handle terminal resize — update ratatui's viewport and
                // force an immediate redraw on the next loop iteration.
                Event::Resize(cols, rows) => {
                    terminal.resize(ratatui::layout::Rect {
                        x: 0,
                        y: 0,
                        width: cols,
                        height: rows,
                    })?;
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

/// Background task: polls agents periodically and handles RPC commands.
/// Spawn a background task that watches `~/.config/nexus/agents.toml` for
/// modifications.  On each write event (debounced 500 ms) the file is
/// re-parsed and the new agent count is sent as `RpcResult::ConfigChanged`.
fn spawn_config_watcher(
    config_path: PathBuf,
    result_tx: mpsc::Sender<RpcResult>,
    rpc_tx: mpsc::Sender<RpcCommand>,
) {
    // Bridge: notify fires on a OS thread; we forward events into a tokio channel.
    let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);

    // `_watcher` must stay alive for the watch to remain active.
    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
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
            let reload_outcome: Option<(usize, NexusConfig)> =
                match nexus_core::config::NexusConfig::load() {
                    Ok(cfg) => {
                        let n = cfg.agents.len();
                        tracing::info!("config reloaded: {n} agents");
                        Some((n, cfg))
                    }
                    Err(e) => {
                        tracing::warn!("config watcher: reload failed: {e}");
                        None
                    }
                };

            if let Some((n, cfg)) = reload_outcome {
                let new_endpoints: Vec<(String, u16)> = cfg
                    .agents
                    .iter()
                    .map(|a| (a.host.clone(), a.port))
                    .collect();
                // Send the parsed config to the background task so it can
                // update the NexusClient agent list.
                let _ = rpc_tx.send(RpcCommand::ReloadConfig(cfg)).await;
                let _ = result_tx
                    .send(RpcResult::ConfigChanged(n, new_endpoints))
                    .await;
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
    // Periodic project details refresh (30s — git operations are slow).
    let mut project_detail_interval = tokio::time::interval(Duration::from_secs(30));
    // Periodic spec list refresh (10s).
    let mut spec_interval = tokio::time::interval(Duration::from_secs(10));
    // Periodic health timeseries refresh (30s).
    let mut health_ts_interval = tokio::time::interval(Duration::from_secs(30));
    // Skip the immediate first tick so reconnects don't race with connect_all.
    reconnect_interval.reset();
    health_ts_interval.reset();

    // Task 1.1: Build reqwest client once before the polling loop to avoid per-tick
    // allocation and surface construction failures early.
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap_or_else(|e| {
            tracing::error!(%e, "failed to build reqwest HTTP client");
            // Fall back to a default client — this should never fail in practice.
            reqwest::Client::new()
        });

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
            _ = project_detail_interval.tick() => {
                let details = client.list_projects_all_enriched().await;
                if !details.is_empty() {
                    let _ = rpc_result_tx.send(RpcResult::ProjectDetails(details)).await;
                }
            }
            _ = spec_interval.tick() => {
                // Fetch specs from the first connected agent's HTTP API.
                if let Some(agent) = client.agents.iter().find(|a| matches!(a.status, crate::client::ConnectionStatus::Connected)) {
                    let url = format!("http://{}:{}/specs", agent.config.host, agent.config.port + 2);
                    // Task 1.1: Use pre-built client (moved above the loop)
                    if let Ok(resp) = http_client.get(&url).send().await
                        && resp.status().is_success()
                        && let Ok(mut specs) = resp.json::<Vec<app::SpecListEntry>>().await
                    {
                        specs.sort_by_key(|s: &app::SpecListEntry| s.status_sort_key());
                        let _ = rpc_result_tx.send(RpcResult::SpecList(specs)).await;
                    }
                }
            }
            _ = health_ts_interval.tick() => {
                let data = client.get_health_time_series(24).await;
                if !data.is_empty() {
                    let _ = rpc_result_tx.send(RpcResult::HealthTimeSeries(data)).await;
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
                            Ok(stream) => {
                                let tx = rpc_result_tx.clone();
                                tokio::spawn(async move {
                                    let mut stream = stream;
                                    loop {
                                        match stream.message().await {
                                            Ok(Some(output)) => {
                                                if tx.send(RpcResult::CommandOutput(output)).await.is_err() {
                                                    break; // receiver dropped
                                                }
                                            }
                                            Ok(None) => {
                                                let _ = tx.send(RpcResult::CommandStreamDone).await;
                                                break;
                                            }
                                            Err(e) => {
                                                tracing::warn!(%e, "send_command stream error");
                                                let _ = tx.send(RpcResult::CommandStreamDone).await;
                                                break;
                                            }
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::warn!(%e, "send_command failed");
                                let _ = rpc_result_tx.send(RpcResult::CommandStreamDone).await;
                            }
                        }
                    }
                    Some(RpcCommand::ReloadConfig(new_config)) => {
                        client.update_config(new_config);
                        // Reconnect any newly-added agents.
                        let reconnected = client.reconnect_disconnected().await;
                        if !reconnected.is_empty() {
                            let _ = rpc_result_tx.send(RpcResult::AgentsReconnected(reconnected)).await;
                        }
                        // Push updated session data immediately.
                        let results = client.get_sessions().await;
                        let data = results_to_agent_data(&client, &results);
                        let _ = poll_tx.send(data).await;
                    }
                    Some(RpcCommand::ListProjects { agent_name }) => {
                        match client.list_projects(&agent_name).await {
                            Ok(projects) => {
                                let _ = rpc_result_tx.send(RpcResult::ProjectList(projects)).await;
                            }
                            Err(e) => {
                                tracing::warn!(%e, "list_projects failed");
                                let _ = rpc_result_tx
                                    .send(RpcResult::ProjectListErr(e.to_string()))
                                    .await;
                            }
                        }
                    }
                    Some(RpcCommand::FetchSessionHistory { days, project }) => {
                        let entries = client.get_session_history(days, project).await;
                        let _ = rpc_result_tx.send(RpcResult::SessionHistory(entries)).await;
                    }
                    Some(RpcCommand::FetchFailureTrends { days }) => {
                        let (daily, by_tool) = client.get_failure_trends(days).await;
                        let _ = rpc_result_tx.send(RpcResult::FailureTrends(daily, by_tool)).await;
                    }
                    Some(RpcCommand::FetchSpecVelocity { days, project }) => {
                        let entries = client.get_spec_velocity(days, project).await;
                        let _ = rpc_result_tx.send(RpcResult::SpecVelocity(entries)).await;
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
        nexus_core::agent::AgentSnapshot,
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
                        nexus_core::agent::AgentSnapshot {
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
                ConnectionStatus::Disconnected { reason } => (None, reason.contains("DNS")),
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
