use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{Json, Router, extract::State, routing::get};
use nexus_core::api::HealthResponse;
use nexus_core::config::{AgentRole, NexusConfig, NotificationConfig};
use nexus_core::proto::nexus_agent_server::NexusAgentServer;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, mpsc};
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use nexus_agent::event_forwarder::EventForwarder;
use nexus_agent::events;
use nexus_agent::grpc::NexusAgentService;
use nexus_agent::health::HealthCollector;
use nexus_agent::notification_engine::NotificationEngine;
use nexus_agent::registry::SessionRegistry;
use nexus_agent::services;
use nexus_agent::services::receiver::ReceiverService;
use nexus_agent::shutdown::ShutdownCoordinator;
use nexus_agent::socket;

const GRPC_PORT: u16 = 7400;
const HTTP_PORT: u16 = 7401;

/// Shared state passed to axum HTTP handlers.
#[derive(Clone)]
struct AppState {
    registry: Arc<SessionRegistry>,
    health: HealthCollector,
    agent_name: String,
    agent_host: String,
    started_at: std::time::Instant,
}

/// Spawn a service and wire it to the cancellation token for shutdown.
///
/// Creates an mpsc channel (the claude-daemon shutdown pattern), then spawns
/// a background task that sends `()` on the channel when the token is
/// cancelled. The service task runs `service.start(rx)`.
fn spawn_service<S>(service: S, token: tokio_util::sync::CancellationToken)
where
    S: services::Service + 'static,
{
    let name = service.name();
    let (shutdown_tx, shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);

    // Watch for token cancellation and forward to mpsc channel.
    tokio::spawn(async move {
        token.cancelled().await;
        let _ = shutdown_tx.send(()).await;
    });

    tokio::spawn(async move {
        tracing::info!("service starting: {}", name);
        if let Err(e) = service.start(shutdown_rx).await {
            tracing::error!("service {} exited with error: {}", name, e);
        } else {
            tracing::info!("service stopped: {}", name);
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("nexus_agent=info".parse()?))
        .init();

    tracing::info!("nexus-agent starting");

    // Resolve agent identity from hostname.
    let agent_host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into());

    // Load agents.toml to determine role and peer list.
    let nexus_config = NexusConfig::load().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "failed to load agents.toml, using defaults (role=primary)");
        NexusConfig {
            agents: vec![],
            role: AgentRole::Primary,
            self_name: None,
        }
    });

    let role = nexus_config.role;
    let agent_name = nexus_config
        .self_name
        .clone()
        .unwrap_or_else(|| agent_host.clone());

    tracing::info!(%agent_name, ?role, "agent identity resolved");

    // Stale socket cleanup: remove leftover socket file from a previous
    // crash, or bail if another instance is already running.
    let socket_path = socket::socket_path();
    socket::cleanup_stale_socket(&socket_path).await?;

    // Initialize the event broadcast channel (capacity 256).
    let event_broadcaster = Arc::new(events::EventBroadcaster::new(256));

    // Initialize session registry with a reference to the broadcaster.
    let registry = Arc::new(SessionRegistry::new(Arc::clone(&event_broadcaster)));

    // Start the health collector with a 5-second refresh interval.
    let health_collector = HealthCollector::spawn(Duration::from_secs(5));

    let started_at = std::time::Instant::now();

    // Create the shutdown coordinator shared between signal handler and gRPC service.
    let coordinator = Arc::new(ShutdownCoordinator::new());

    // Role-gated: start ReceiverService only on Primary.
    // Agent role skips TTS/APNs/banner — no audio deps needed at runtime.
    let receiver = Arc::new(ReceiverService::new());
    if role == AgentRole::Primary {
        spawn_service(Arc::clone(&receiver), coordinator.token());
        tracing::info!("ReceiverService started (role=primary)");
    } else {
        tracing::info!("ReceiverService skipped (role=agent)");
    }

    // Cross-platform background services.
    spawn_service(
        services::git_watch::GitWatchService::new(60),
        coordinator.token(),
    );
    spawn_service(
        services::sync_telemetry::SyncTelemetryService::new(),
        coordinator.token(),
    );
    spawn_service(
        services::credential_watcher::CredentialWatcherService::new(2),
        coordinator.token(),
    );

    // Linux-only services.
    #[cfg(target_os = "linux")]
    {
        spawn_service(
            services::server_monitor::ServerMonitorService::new(
                30,
                services::server_monitor::ServerMonitorService::default_state_path(),
            ),
            coordinator.token(),
        );
        spawn_service(
            services::systemd_health::SystemdHealthService::new(30),
            coordinator.token(),
        );
    }

    // macOS-only services.
    #[cfg(target_os = "macos")]
    {
        spawn_service(
            services::launchd_health::LaunchdHealthService::new(60),
            coordinator.token(),
        );
        spawn_service(
            services::macos_integration::MacOSIntegrationService::new(30),
            coordinator.token(),
        );
    }

    // Role-gated: wire NotificationEngine and EventForwarder only on Primary.
    // The lifecycle channel feeds both local socket events and remote gRPC events
    // into the NotificationEngine for per-project TTS delivery.
    //
    // `notification_config_arc` is kept alive here so it can be shared with the
    // socket service for `notification_rules` / `notification_set` commands.
    let notification_config_arc: Option<Arc<RwLock<NotificationConfig>>>;
    let lifecycle_tx: Option<tokio::sync::mpsc::Sender<nexus_core::lifecycle::LifecycleEvent>> =
        if role == AgentRole::Primary {
            let notification_config = NotificationConfig::load().unwrap_or_else(|e| {
                tracing::warn!(
                    error = %e,
                    "failed to load notifications.toml, using defaults"
                );
                NotificationConfig::default()
            });
            tracing::info!(
                projects = notification_config.projects.len(),
                "NotificationConfig loaded"
            );

            let config_arc = Arc::new(RwLock::new(notification_config));
            notification_config_arc = Some(Arc::clone(&config_arc));

            let (tx, rx) = mpsc::channel::<nexus_core::lifecycle::LifecycleEvent>(256);

            // Start hot-reload watcher for notifications.toml.
            nexus_agent::notification_engine::spawn_config_watcher(Arc::clone(&config_arc));

            // Start the NotificationEngine — drains rx and delivers TTS.
            let engine = NotificationEngine::new(Arc::clone(&config_arc), Arc::clone(&receiver));
            engine.spawn(rx);

            // Start EventForwarder — subscribes to all peer agents' gRPC streams.
            let peers: Vec<nexus_core::config::AgentConfig> = nexus_config
                .peers(&agent_name)
                .into_iter()
                .cloned()
                .collect();
            if peers.is_empty() {
                tracing::info!("EventForwarder: no peers configured, skipping");
            } else {
                tracing::info!(peer_count = peers.len(), "EventForwarder starting");
                EventForwarder::new(peers).spawn(tx.clone());
            }

            tracing::info!("NotificationEngine and EventForwarder started (role=primary)");
            Some(tx)
        } else {
            notification_config_arc = None;
            tracing::info!("NotificationEngine and EventForwarder skipped (role=agent)");
            None
        };

    // Build the gRPC service.
    let service = NexusAgentService::new(
        Arc::clone(&registry),
        Arc::clone(&event_broadcaster),
        health_collector.clone(),
        agent_name.clone(),
        agent_host.clone(),
        Arc::clone(&coordinator),
    );

    let grpc_addr = format!("0.0.0.0:{GRPC_PORT}").parse()?;
    tracing::info!("gRPC server listening on {}", grpc_addr);

    // Cancellation token for socket service — cancelled when the agent shuts down.
    let socket_cancel = coordinator.token();

    let shutdown_coordinator = Arc::clone(&coordinator);
    let grpc_server = Server::builder()
        .add_service(NexusAgentServer::new(service))
        .serve_with_shutdown(grpc_addr, async move {
            shutdown_signal().await;
            shutdown_coordinator.initiate_shutdown();
            shutdown_coordinator
                .wait_for_drain(Duration::from_secs(5))
                .await;
        });

    // Start stale session detection background task (30s interval).
    let stale_registry = Arc::clone(&registry);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            stale_registry
                .detect_stale(
                    std::time::Duration::from_secs(300), // 5min → Stale
                    std::time::Duration::from_secs(900), // 15min → Remove
                )
                .await;
        }
    });

    // Build the HTTP health server on port 7401.
    let app_state = AppState {
        registry: Arc::clone(&registry),
        health: health_collector,
        agent_name,
        agent_host,
        started_at,
    };

    let http_app = Router::new()
        .route("/health", get(health_handler))
        .route("/statusline", get(statusline_handler))
        .with_state(app_state);

    let http_addr: std::net::SocketAddr = format!("0.0.0.0:{HTTP_PORT}").parse()?;
    let http_listener = tokio::net::TcpListener::bind(http_addr).await?;
    tracing::info!("HTTP health server listening on {}", http_addr);

    // Build peer relay URLs for agent role: forward notifications to primary's HTTP port 9999.
    let peer_relay_urls: socket::PeerRelayUrls = if role == AgentRole::Agent {
        nexus_config
            .peers(nexus_config.self_name.as_deref().unwrap_or("unknown"))
            .iter()
            .map(|peer| format!("http://{}:9999", peer.host))
            .collect()
    } else {
        vec![] // primary handles locally
    };
    if !peer_relay_urls.is_empty() {
        tracing::info!(peers = ?peer_relay_urls, "notification relay configured (role=agent)");
    }

    // Spawn the Unix domain socket service for hook event ingestion.
    // role=primary: notifications handled locally via ReceiverService
    // role=agent: notifications relayed to primary peer via HTTP
    let socket_registry = Arc::clone(&registry);
    let socket_service = socket::run_socket_service(
        socket_registry,
        Arc::clone(&receiver),
        socket_cancel,
        lifecycle_tx,
        notification_config_arc,
        peer_relay_urls,
    );

    tracing::info!(
        "listening on gRPC=0.0.0.0:{GRPC_PORT} HTTP=0.0.0.0:{HTTP_PORT} socket={}",
        socket_path.display()
    );

    // Notify systemd that the service is ready (Linux only).
    #[cfg(target_os = "linux")]
    {
        if let Ok(notify_socket) = std::env::var("NOTIFY_SOCKET") {
            if !notify_socket.is_empty() {
                use std::os::unix::net::UnixDatagram;
                if let Ok(sock) = UnixDatagram::unbound() {
                    let _ = sock.send_to(b"READY=1", &notify_socket);
                    tracing::info!("sd_notify: READY=1 sent");
                }
            }
        }
    }

    // Run all core services concurrently. If any exits, the others are dropped.
    tokio::select! {
        result = grpc_server => {
            if let Err(e) = result {
                tracing::error!("gRPC server error: {}", e);
            }
        }
        result = axum::serve(http_listener, http_app).into_future() => {
            if let Err(e) = result {
                tracing::error!("HTTP health server error: {}", e);
            }
        }
        result = socket_service => {
            if let Err(e) = result {
                tracing::error!("socket service error: {}", e);
            }
        }
    }

    tracing::info!("nexus-agent shutting down");
    Ok(())
}

/// GET /health — return JSON HealthResponse with cached machine metrics.
async fn health_handler(State(state): State<AppState>) -> Json<HealthResponse> {
    let machine = state.health.get().await;
    let sessions = state.registry.get_all().await;

    Json(HealthResponse {
        agent_name: state.agent_name.clone(),
        agent_host: state.agent_host.clone(),
        uptime_seconds: state.started_at.elapsed().as_secs(),
        session_count: sessions.len(),
        machine: Some(machine),
    })
}

// -- Statusline types and handler --

#[derive(Debug, Serialize, Deserialize)]
struct StatuslineSession {
    id: String,
    project: Option<String>,
    status: String,
    model: Option<String>,
    spec: Option<String>,
    cwd: String,
    idle_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StatuslineGit {
    branch: String,
    dirty: bool,
    ahead: u32,
    behind: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct StatuslineMachine {
    cpu_percent: f32,
    mem_percent: f32,
    load_1m: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct StatuslineResponse {
    sessions: Vec<StatuslineSession>,
    git: Option<StatuslineGit>,
    machine: StatuslineMachine,
    uptime_seconds: u64,
    daemon_count: usize,
}

/// GET /statusline — return compact JSON for the CC statusline script.
async fn statusline_handler(State(state): State<AppState>) -> Json<StatuslineResponse> {
    let machine = state.health.get().await;
    let sessions = state.registry.get_all().await;

    // Convert sessions to compact statusline format.
    let statusline_sessions: Vec<StatuslineSession> = sessions
        .iter()
        .map(|s| StatuslineSession {
            id: s.id.clone(),
            project: s.project.clone(),
            status: format!("{:?}", s.status).to_lowercase(),
            model: s.model.clone(),
            spec: s.spec.clone(),
            cwd: s.cwd.clone(),
            idle_seconds: s.idle_seconds(),
        })
        .collect();

    let daemon_count = statusline_sessions.len();

    // Compute mem_percent from used/total.
    let mem_percent = if machine.memory_total_gb > 0.0 {
        (machine.memory_used_gb / machine.memory_total_gb) * 100.0
    } else {
        0.0
    };

    // Get git status for the current working directory (cached with 5s TTL).
    let git = get_git_status_cached().await;

    Json(StatuslineResponse {
        sessions: statusline_sessions,
        git,
        machine: StatuslineMachine {
            cpu_percent: machine.cpu_percent,
            mem_percent,
            load_1m: machine.load_avg[0],
        },
        uptime_seconds: state.started_at.elapsed().as_secs(),
        daemon_count,
    })
}

/// Git status cache — avoids shelling out on every statusline request.
/// Refreshes every 5 seconds at most.
static GIT_STATUS_CACHE: std::sync::OnceLock<tokio::sync::Mutex<GitStatusCache>> =
    std::sync::OnceLock::new();

struct GitStatusCache {
    value: Option<StatuslineGit>,
    refreshed_at: std::time::Instant,
}

async fn get_git_status_cached() -> Option<StatuslineGit> {
    const TTL: Duration = Duration::from_secs(5);

    let mutex = GIT_STATUS_CACHE.get_or_init(|| {
        tokio::sync::Mutex::new(GitStatusCache {
            value: None,
            refreshed_at: std::time::Instant::now()
                .checked_sub(TTL + Duration::from_secs(1))
                .unwrap_or(std::time::Instant::now()),
        })
    });

    let mut cache = mutex.lock().await;
    if cache.refreshed_at.elapsed() >= TTL {
        cache.value = fetch_git_status().await;
        cache.refreshed_at = std::time::Instant::now();
    }
    cache.value.clone()
}

/// Shell out to git to collect branch, dirty flag, ahead/behind counts.
/// Runs in the process working directory (which is the nexus-agent launch dir,
/// typically ~/.claude or ~/). Returns None if git is not available or the
/// directory is not a git repo.
async fn fetch_git_status() -> Option<StatuslineGit> {
    // Get branch name.
    let branch_out = tokio::process::Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .await
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return None;
    }

    // Check dirty state via porcelain status.
    let status_out = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .await
        .ok()?;
    let dirty = !status_out.stdout.is_empty();

    // Count commits ahead/behind upstream.
    let (ahead, behind) = if let Ok(rev_out) = tokio::process::Command::new("git")
        .args(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        .output()
        .await
    {
        if rev_out.status.success() {
            let s = String::from_utf8_lossy(&rev_out.stdout);
            let parts: Vec<&str> = s.trim().split_whitespace().collect();
            if parts.len() == 2 {
                let behind = parts[0].parse::<u32>().unwrap_or(0);
                let ahead = parts[1].parse::<u32>().unwrap_or(0);
                (ahead, behind)
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Some(StatuslineGit {
        branch,
        dirty,
        ahead,
        behind,
    })
}

/// Wait for SIGTERM or Ctrl+C to trigger graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();

    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");

        tokio::select! {
            _ = ctrl_c => tracing::info!("received Ctrl+C, shutting down"),
            _ = sigterm.recv() => tracing::info!("received SIGTERM, shutting down"),
        }
    }

    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
        tracing::info!("received Ctrl+C, shutting down");
    }
}
