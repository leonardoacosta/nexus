use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::{Json, Router, extract::{Path, Query, State}, http::StatusCode, routing::get};
use nexus_core::api::HealthResponse;
use nexus_core::config::{AgentRole, NexusConfig, NotificationConfig};
use nexus_core::project_registry::ProjectRegistry;
use nexus_core::proto::nexus_agent_server::NexusAgentServer;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, mpsc};
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use nexus_agent::cron::CronService;
use nexus_agent::cron_state::{CronResponse, CronState};
use nexus_agent::environment::{EnvironmentCache, EnvironmentResponse};
use nexus_agent::event_forwarder::EventForwarder;
use nexus_agent::events;
use nexus_agent::failures::{FailureBuffer, HttpFailuresResponse};
use nexus_agent::grpc::NexusAgentService;
use nexus_agent::health::HealthCollector;
use nexus_agent::notification_engine::NotificationEngine;
use nexus_agent::registry::SessionRegistry;
use nexus_agent::services;
use nexus_agent::services::project_status::ProjectStatusCache;
use nexus_agent::services::session_pool::SessionPool;
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
    environment_cache: Arc<EnvironmentCache>,
    failure_buffer: FailureBuffer,
    cron_state: CronState,
    agent_name: String,
    agent_host: String,
    started_at: std::time::Instant,
    project_registry: ProjectRegistry,
    status_cache: ProjectStatusCache,
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
            pool: None,
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

    // Load project registry (falls back gracefully if projects.json missing).
    let project_registry = ProjectRegistry::load().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "failed to load project registry, using empty registry");
        ProjectRegistry::load_empty()
    });

    // Initialize project status cache with 30-second TTL.
    let status_cache = ProjectStatusCache::new(Duration::from_secs(30));

    // Initialize and spawn the session pool service.
    let pool_config = nexus_config.pool.clone().unwrap_or_default();
    let session_pool = SessionPool::new(pool_config, project_registry.clone());
    spawn_service(session_pool.clone(), coordinator.token());
    tracing::info!("SessionPool service started");

    // Build the gRPC service.
    let service = NexusAgentService::new(
        Arc::clone(&registry),
        Arc::clone(&event_broadcaster),
        health_collector.clone(),
        agent_name.clone(),
        agent_host.clone(),
        Arc::clone(&coordinator),
        project_registry.clone(),
        status_cache.clone(),
        session_pool,
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

    // Initialize the in-memory failure ring buffer for tool_use_fail tracking.
    let failure_buffer = FailureBuffer::new();

    // Bootstrap failure buffer from historical JSONL files (last 30 days).
    if let Some(home) = dirs::home_dir() {
        let failures_dir = home.join(".claude/scripts/state/failures");
        if failures_dir.is_dir() {
            let count = failure_buffer.bootstrap_from_jsonl(&failures_dir).await;
            tracing::info!("Imported {} failure events from JSONL files", count);
        }
    }

    // Initialize shared cron state and spawn CronService.
    let cron_state = CronState::new();
    spawn_service(
        CronService::new(cron_state.clone()),
        coordinator.token(),
    );

    // Build the HTTP health server on port 7401.
    let app_state = AppState {
        registry: Arc::clone(&registry),
        health: health_collector,
        environment_cache: Arc::new(EnvironmentCache::new()),
        failure_buffer: failure_buffer.clone(),
        cron_state,
        agent_name,
        agent_host,
        started_at,
        project_registry,
        status_cache,
    };

    let http_app = Router::new()
        .route("/health", get(health_handler))
        .route("/statusline", get(statusline_handler))
        .route("/recommend", get(recommend_handler))
        .route("/environment", get(environment_handler))
        .route("/failures", get(failures_handler))
        .route("/cron", get(cron_handler))
        .route("/project/:code/status", get(project_status_handler))
        .route("/project/:code/beads", get(project_beads_handler))
        .route("/project/:code/git", get(project_git_handler))
        .route("/project/:code/specs", get(project_specs_handler))
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
        failure_buffer,
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

// -- Recommend types and handler --

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Recommendation {
    id: String,
    title: String,
    score: i32,
    reason: String,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecommendContext {
    project: String,
    active_spec: Option<String>,
    session_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecommendResponse {
    recommendations: Vec<Recommendation>,
    context: RecommendContext,
}

/// Cached recommend response with TTL.
struct RecommendCache {
    response: Option<RecommendResponse>,
    refreshed_at: Instant,
}

static RECOMMEND_CACHE: std::sync::OnceLock<Mutex<RecommendCache>> = std::sync::OnceLock::new();

/// GET /recommend — return scored work recommendations.
///
/// Shells out to `bd ready --json` for available tasks, reads
/// `~/.claude/scripts/state/master-context.json` for project context,
/// then scores and ranks items. Results are cached for 30 seconds.
async fn recommend_handler(State(state): State<AppState>) -> Json<RecommendResponse> {
    const TTL: Duration = Duration::from_secs(30);

    let session_count = state.registry.get_all().await.len();

    let mutex = RECOMMEND_CACHE.get_or_init(|| {
        Mutex::new(RecommendCache {
            response: None,
            refreshed_at: Instant::now()
                .checked_sub(TTL + Duration::from_secs(1))
                .unwrap_or(Instant::now()),
        })
    });

    let mut cache = mutex.lock().await;

    // Return cached response if still fresh (update session_count).
    if cache.refreshed_at.elapsed() < TTL {
        if let Some(ref mut resp) = cache.response {
            resp.context.session_count = session_count;
            return Json(resp.clone());
        }
    }

    // Build fresh response.
    let response = build_recommendations(session_count).await;
    cache.response = Some(response.clone());
    cache.refreshed_at = Instant::now();

    Json(response)
}

/// Master-context.json structure (subset we care about).
#[derive(Debug, Deserialize, Default)]
struct MasterContext {
    #[serde(default)]
    project: MasterContextProject,
    #[serde(default)]
    state: MasterContextState,
}

#[derive(Debug, Deserialize, Default)]
struct MasterContextProject {
    #[serde(default)]
    name: String,
    #[serde(default)]
    scope: String,
}

#[derive(Debug, Deserialize, Default)]
struct MasterContextState {
    #[serde(default)]
    active_spec: String,
}

/// A single item from `bd ready --json`.
#[derive(Debug, Deserialize)]
struct BeadsReadyItem {
    id: String,
    title: String,
    #[serde(default = "default_priority")]
    priority: i32,
    #[serde(default)]
    issue_type: String,
    #[serde(default)]
    created_at: String,
}

fn default_priority() -> i32 {
    4
}

/// Build recommendations by gathering data and scoring.
async fn build_recommendations(session_count: usize) -> RecommendResponse {
    // Run bd ready --json and read master-context.json in parallel.
    let (bd_result, context_result) = tokio::join!(fetch_bd_ready(), fetch_master_context());

    let ready_items = bd_result.unwrap_or_default();
    let context = context_result.unwrap_or_default();

    let project_name = if !context.project.name.is_empty() {
        context.project.name.clone()
    } else if !context.project.scope.is_empty() {
        context.project.scope.trim_start_matches('@').to_string()
    } else {
        String::new()
    };

    let active_spec = if context.state.active_spec.is_empty() {
        None
    } else {
        Some(context.state.active_spec.clone())
    };

    let mut recommendations: Vec<Recommendation> = Vec::new();

    // Check for failure spike — query /failures endpoint on localhost.
    if let Some(failure_rec) = check_failure_spike().await {
        recommendations.push(failure_rec);
    }

    let now_epoch = chrono::Utc::now().timestamp();

    for item in &ready_items {
        let mut score: i32;
        let mut reasons: Vec<String> = Vec::new();

        // Base score from priority weight.
        match item.priority {
            0 => {
                score = 100;
                reasons.push("P0 broken".into());
            }
            1 => {
                score = 80;
                reasons.push("P1 critical".into());
            }
            2 => {
                score = 60;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
            3 => {
                score = 40;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
            _ => {
                score = 20;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
        }

        // Same-project bonus (+25).
        if !project_name.is_empty() {
            let prefix = format!("{}-", project_name);
            if item.id.starts_with(&prefix) {
                score += 25;
                reasons.push("same project".into());
            }
        }

        // Active-spec match (+30).
        if let Some(ref spec) = active_spec {
            if !spec.is_empty()
                && item
                    .title
                    .to_lowercase()
                    .contains(&spec.to_lowercase())
            {
                score += 30;
                reasons.push("active spec".into());
            }
        }

        // Stale item bonus (+5 if >7 days old).
        if !item.created_at.is_empty() {
            if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&item.created_at) {
                let age_days = (now_epoch - created.timestamp()) / 86400;
                if age_days > 7 {
                    score += 5;
                    reasons.push("stale >7d".into());
                }
            }
        }

        recommendations.push(Recommendation {
            id: item.id.clone(),
            title: item.title.clone(),
            score,
            reason: reasons.join(", "),
            item_type: if item.issue_type.is_empty() {
                "task".into()
            } else {
                item.issue_type.clone()
            },
        });
    }

    // Sort by score descending.
    recommendations.sort_by(|a, b| b.score.cmp(&a.score));

    RecommendResponse {
        recommendations,
        context: RecommendContext {
            project: project_name,
            active_spec,
            session_count,
        },
    }
}

/// Shell out to `bd ready --json` asynchronously.
async fn fetch_bd_ready() -> Option<Vec<BeadsReadyItem>> {
    let output = tokio::process::Command::new("bd")
        .args(["ready", "--json"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<BeadsReadyItem>>(&stdout).ok()
}

/// Read and parse ~/.claude/scripts/state/master-context.json.
async fn fetch_master_context() -> Option<MasterContext> {
    let home = dirs::home_dir()?;
    let path = home.join(".claude/scripts/state/master-context.json");
    let contents = tokio::fs::read_to_string(&path).await.ok()?;
    serde_json::from_str::<MasterContext>(&contents).ok()
}

/// Check for failure spike by querying the local /failures endpoint.
/// Returns a synthetic recommendation if failures exceed 50/day.
async fn check_failure_spike() -> Option<Recommendation> {
    // Query the /failures endpoint with days=1 for a 24-hour window.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;

    let resp = client
        .get(format!("http://127.0.0.1:{HTTP_PORT}/failures?days=1"))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    // Parse only the total field from the response.
    #[derive(Deserialize)]
    struct FailureSummary {
        #[serde(default)]
        total: u64,
    }

    let summary: FailureSummary = resp.json().await.ok()?;

    if summary.total > 50 {
        Some(Recommendation {
            id: String::new(),
            title: format!("Investigate tool failures ({} in last 24h)", summary.total),
            score: 30,
            reason: format!("failure spike: {} failures/day", summary.total),
            item_type: "investigation".into(),
        })
    } else {
        None
    }
}

/// GET /environment — return dependency, config, and service checks.
///
/// Results are cached for 60 seconds because dependency checks shell out to
/// `which` and `--version` for each binary.
async fn environment_handler(State(state): State<AppState>) -> Json<EnvironmentResponse> {
    let uptime_seconds = state.started_at.elapsed().as_secs();
    Json(state.environment_cache.get(uptime_seconds).await)
}

// -- Failures endpoint --

/// Query parameters for `GET /failures`.
#[derive(Debug, Deserialize)]
struct FailuresParams {
    /// Number of days to query (default: 7).
    #[serde(default = "default_failures_days")]
    days: u32,
}

fn default_failures_days() -> u32 {
    7
}

/// GET /failures — return aggregated tool failure data.
///
/// Queries the in-memory failure ring buffer for the specified time window
/// and returns counts by tool, project, top error summaries, and a
/// current-vs-previous-period trend comparison.
async fn failures_handler(
    State(state): State<AppState>,
    Query(params): Query<FailuresParams>,
) -> Json<HttpFailuresResponse> {
    Json(state.failure_buffer.query_http(params.days).await)
}

/// GET /cron — return cron job run history.
///
/// Reads from the shared `CronState` that CronService populates after each
/// job run. Returns null for last_run/last_status/last_log if a job hasn't
/// run yet.
async fn cron_handler(State(state): State<AppState>) -> Json<CronResponse> {
    let snapshot = state.cron_state.snapshot().await;
    Json(CronResponse {
        jobs: snapshot.into_iter().map(|(k, v)| (k, v.into())).collect(),
    })
}

// ---------------------------------------------------------------------------
// Project status handlers
// ---------------------------------------------------------------------------

/// Query parameters for project status endpoints.
#[derive(Debug, Deserialize)]
struct ProjectStatusQuery {
    /// Force a fresh collection bypassing the cache.
    fresh: Option<bool>,
}

/// GET /project/:code/status — return aggregated beads + git + specs status.
async fn project_status_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    Ok(Json(serde_json::to_value(&status).unwrap()))
}

/// GET /project/:code/beads — return beads status only.
async fn project_beads_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    Ok(Json(serde_json::to_value(&status.beads).unwrap()))
}

/// GET /project/:code/git — return git status only.
async fn project_git_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    Ok(Json(serde_json::to_value(&status.git).unwrap()))
}

/// GET /project/:code/specs — return openspec status only.
async fn project_specs_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    Ok(Json(serde_json::to_value(&status.spec).unwrap()))
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
