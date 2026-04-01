use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{Router, routing::get};
use nexus_core::config::{AgentRole, NexusConfig, NotificationConfig};
use nexus_core::db::NexusDb;
use nexus_core::project_registry::ProjectRegistry;
use nexus_core::proto::nexus_agent_server::NexusAgentServer;
use tokio::sync::{RwLock, mpsc};
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use nexus_agent::cron::CronService;
use nexus_agent::cron_state::CronState;
use nexus_agent::environment::EnvironmentCache;
use nexus_agent::event_forwarder::EventForwarder;
use nexus_agent::events;
use nexus_agent::failures::FailureBuffer;
use nexus_agent::grpc::{AgentServiceConfig, NexusAgentService};
use nexus_agent::health::HealthCollector;
use nexus_agent::http_handlers::{
    AppState, analytics_credentials_handler, analytics_cron_handler, analytics_git_handler,
    analytics_health_handler, analytics_lifecycle_handler, analytics_specs_handler,
    approve_spec_handler, credentials_handler, cron_handler, environment_handler, events_handler,
    failures_handler, get_spec_handler, health_handler, hooks_handler,
    list_commands_by_namespace_handler, list_commands_handler, list_specs_handler,
    project_beads_handler, project_git_handler, project_specs_handler, project_status_handler,
    read_spec_handler, recommend_handler, reject_spec_handler, run_command_handler,
    spec_status_handler, specs_all_handler, statusline_handler,
};
use nexus_agent::notification_engine::NotificationEngine;
use nexus_agent::registry::SessionRegistry;
use nexus_agent::services;
use nexus_agent::services::command_registry::CommandRegistry;
use nexus_agent::services::credential_pool::{CredentialPool, CredentialPoolService};
use nexus_agent::services::project_status::ProjectStatusCache;
use nexus_agent::services::receiver::ReceiverService;
use nexus_agent::services::session_pool::SessionPool;
use nexus_agent::services::spec_watcher::SpecWatcherService;
use nexus_agent::shutdown::ShutdownCoordinator;
use nexus_agent::socket;

const GRPC_PORT: u16 = 7400;
const HTTP_PORT: u16 = 7402;

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

    // Load ~/.env for machine-local secrets (ELEVENLABS_API_KEY, APNS_*, etc.)
    // Mirrors the systemd EnvironmentFile=-%h/.env pattern for macOS launchd.
    if let Some(home) = std::env::var_os("HOME") {
        let env_path = std::path::PathBuf::from(home).join(".env");
        match dotenvy::from_path(&env_path) {
            Ok(()) => tracing::info!("loaded env from {}", env_path.display()),
            Err(e) => tracing::debug!("no .env loaded from {}: {}", env_path.display(), e),
        }
    }

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
            bind_address: "127.0.0.1".to_string(),
            secret: None,
        }
    });

    let role = nexus_config.role;
    let agent_name = nexus_config
        .self_name
        .clone()
        .unwrap_or_else(|| agent_host.clone());

    tracing::info!(%agent_name, ?role, "agent identity resolved");

    // Initialize the SQLite backing store.
    let db_path = nexus_core::paths::nexus_config_dir().join("nexus.db");
    let db = Arc::new(NexusDb::open(&db_path)?);
    db.migrate()?;
    tracing::info!(path = %db_path.display(), "NexusDb initialized");

    // Record agent startup in the lifecycle table.
    if let Err(e) = db.insert_lifecycle_event(&nexus_core::db::AgentLifecycleRecord {
        id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
        event_type: "start".to_string(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        uptime_seconds: None,
        reason: None,
    }) {
        tracing::warn!("failed to record startup lifecycle event: {e}");
    }

    // Stale socket cleanup: remove leftover socket file from a previous
    // crash, or bail if another instance is already running.
    let socket_path = socket::socket_path();
    socket::cleanup_stale_socket(&socket_path).await?;

    // Initialize the event broadcast channel (capacity 256).
    let event_broadcaster = Arc::new(events::EventBroadcaster::new(256));

    // Initialize session registry with a reference to the broadcaster and DB.
    let registry = Arc::new(
        SessionRegistry::new(Arc::clone(&event_broadcaster))
            .with_db(Arc::clone(&db))
            .await,
    );

    // Start the health collector with a 5-second refresh interval and DB sampling.
    let health_collector =
        HealthCollector::spawn_with_db(Duration::from_secs(5), Some(Arc::clone(&db)));

    let started_at = std::time::Instant::now();

    // Create the shutdown coordinator shared between signal handler and gRPC service.
    let coordinator = Arc::new(ShutdownCoordinator::new());

    // Build a shared HTTP client for outbound requests (reused by services and
    // the HTTP handler layer to avoid per-request connection pool overhead).
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to create shared reqwest::Client");

    // Role-gated: start ReceiverService only on Primary.
    // Agent role skips TTS/APNs/banner — no audio deps needed at runtime.
    let receiver =
        Arc::new(ReceiverService::new().with_bind_address(nexus_config.bind_address.clone()));
    if role == AgentRole::Primary {
        spawn_service(Arc::clone(&receiver), coordinator.token());
        tracing::info!("ReceiverService started (role=primary)");
    } else {
        tracing::info!("ReceiverService skipped (role=agent)");
    }

    // Cross-platform background services.
    spawn_service(
        services::git_watch::GitWatchService::new(60).with_db(Arc::clone(&db)),
        coordinator.token(),
    );
    spawn_service(
        services::sync_telemetry::SyncTelemetryService::with_client(http_client.clone()),
        coordinator.token(),
    );
    spawn_service(
        services::credential_watcher::CredentialWatcherService::with_client(2, http_client.clone()),
        coordinator.token(),
    );

    // Initialize and spawn the credential pool service with DB backing.
    let credential_pool_service =
        CredentialPoolService::new(http_client.clone()).with_db(Arc::clone(&db));
    let credential_pool: Arc<CredentialPool> = credential_pool_service.pool();
    spawn_service(credential_pool_service, coordinator.token());
    tracing::info!("CredentialPoolService started");

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

    // Initialize and spawn the spec watcher service.
    spawn_service(
        SpecWatcherService::new(
            project_registry.clone(),
            status_cache.clone(),
            Arc::clone(&db),
        ),
        coordinator.token(),
    );
    tracing::info!("SpecWatcherService started");

    // Initialize the command registry (scans ~/.claude/commands/ on startup).
    let command_registry = CommandRegistry::with_default_dir();
    tracing::info!("CommandRegistry initialized");

    // Build the gRPC service.
    let service = NexusAgentService::new(AgentServiceConfig {
        registry: Arc::clone(&registry),
        events: Arc::clone(&event_broadcaster),
        health: health_collector.clone(),
        agent_name: agent_name.clone(),
        agent_host: agent_host.clone(),
        shutdown: Arc::clone(&coordinator),
        project_registry: project_registry.clone(),
        status_cache: status_cache.clone(),
        session_pool,
        command_registry: command_registry.clone(),
        db: Arc::clone(&db),
    });

    let bind_address = &nexus_config.bind_address;
    let effective_secret = nexus_config.effective_secret();

    let grpc_addr = format!("{bind_address}:{GRPC_PORT}").parse()?;
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

    // Initialize the SQL-backed failure buffer (replaces the old VecDeque + JSONL bootstrap).
    let failure_buffer = FailureBuffer::new(Arc::clone(&db));

    // Initialize shared cron state and spawn CronService.
    let cron_state = CronState::new();
    spawn_service(
        CronService::new(cron_state.clone(), Arc::clone(&db)),
        coordinator.token(),
    );

    // Clone credential pool for the socket service (before moving into AppState).
    let socket_credential_pool = Arc::clone(&credential_pool);

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
        command_registry,
        secret: effective_secret,
        http_client,
        credential_pool,
        db: Arc::clone(&db),
    };

    let socket_http_client = app_state.http_client.clone();
    let http_app = Router::new()
        .route("/health", get(health_handler))
        .route("/statusline", get(statusline_handler))
        .route("/credentials", get(credentials_handler))
        .route("/hooks", axum::routing::post(hooks_handler))
        .route("/recommend", get(recommend_handler))
        .route("/environment", get(environment_handler))
        .route("/failures", get(failures_handler))
        .route("/cron", get(cron_handler))
        .route("/specs/all", get(specs_all_handler))
        .route("/specs", get(list_specs_handler))
        .route("/specs/{project}/{name}", get(get_spec_handler))
        .route(
            "/specs/{project}/{name}/approve",
            axum::routing::post(approve_spec_handler),
        )
        .route(
            "/specs/{project}/{name}/reject",
            axum::routing::post(reject_spec_handler),
        )
        .route(
            "/specs/{project}/{name}/read",
            axum::routing::post(read_spec_handler),
        )
        .route("/specs/{project}/{name}/status", get(spec_status_handler))
        .route("/events", get(events_handler))
        .route("/commands", get(list_commands_handler))
        .route(
            "/commands/{namespace}",
            get(list_commands_by_namespace_handler),
        )
        .route("/project/{code}/status", get(project_status_handler))
        .route("/project/{code}/beads", get(project_beads_handler))
        .route("/project/{code}/git", get(project_git_handler))
        .route("/project/{code}/specs", get(project_specs_handler))
        .route(
            "/project/{code}/run",
            axum::routing::post(run_command_handler),
        )
        .route("/analytics/health", get(analytics_health_handler))
        .route("/analytics/specs", get(analytics_specs_handler))
        .route("/analytics/credentials", get(analytics_credentials_handler))
        .route("/analytics/git", get(analytics_git_handler))
        .route("/analytics/lifecycle", get(analytics_lifecycle_handler))
        .route("/analytics/cron", get(analytics_cron_handler))
        .with_state(app_state);

    let http_addr: std::net::SocketAddr = format!("{bind_address}:{HTTP_PORT}").parse()?;
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
    let socket_service = socket::run_socket_service(socket::SocketContext {
        registry: Arc::clone(&registry),
        receiver: Arc::clone(&receiver),
        cancel: socket_cancel,
        lifecycle_tx,
        notification_config: notification_config_arc,
        peer_relay_urls,
        failure_buffer,
        http_client: socket_http_client,
        credential_pool: socket_credential_pool,
        db: Arc::clone(&db),
    });

    tracing::info!(
        "listening on gRPC={bind_address}:{GRPC_PORT} HTTP={bind_address}:{HTTP_PORT} socket={}",
        socket_path.display()
    );

    // Notify systemd that the service is ready (Linux only).
    #[cfg(target_os = "linux")]
    {
        if let Ok(notify_socket) = std::env::var("NOTIFY_SOCKET")
            && !notify_socket.is_empty()
        {
            use std::os::unix::net::UnixDatagram;
            if let Ok(sock) = UnixDatagram::unbound() {
                let _ = sock.send_to(b"READY=1", &notify_socket);
                tracing::info!("sd_notify: READY=1 sent");
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

    // Record agent shutdown in the lifecycle table.
    let uptime_secs = started_at.elapsed().as_secs() as i64;
    if let Err(e) = db.insert_lifecycle_event(&nexus_core::db::AgentLifecycleRecord {
        id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
        event_type: "stop".to_string(),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        uptime_seconds: Some(uptime_secs),
        reason: Some("shutdown".to_string()),
    }) {
        tracing::warn!("failed to record shutdown lifecycle event: {e}");
    }

    tracing::info!("nexus-agent shutting down");
    Ok(())
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
