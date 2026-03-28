use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::{Json, Router, extract::State, routing::get};
use nexus_core::api::HealthResponse;
use nexus_core::proto::nexus_agent_server::NexusAgentServer;
use tonic::transport::Server;
use tracing_subscriber::EnvFilter;

use nexus_agent::events;
use nexus_agent::grpc::NexusAgentService;
use nexus_agent::health::HealthCollector;
use nexus_agent::registry::SessionRegistry;
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
    let agent_name = agent_host.clone();

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
        .with_state(app_state);

    let http_addr: std::net::SocketAddr = format!("0.0.0.0:{HTTP_PORT}").parse()?;
    let http_listener = tokio::net::TcpListener::bind(http_addr).await?;
    tracing::info!("HTTP health server listening on {}", http_addr);

    // Spawn the Unix domain socket service for hook event ingestion.
    let socket_registry = Arc::clone(&registry);
    let socket_service = socket::run_socket_service(socket_registry, socket_cancel);

    tracing::info!(
        "listening on gRPC=0.0.0.0:{GRPC_PORT} HTTP=0.0.0.0:{HTTP_PORT} socket={}",
        socket_path.display()
    );

    // Run all three services concurrently. If any exits, the others are dropped.
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
