//! Integration test: GET /credentials without X-Nexus-Secret returns 401
//! when a secret is configured (task 6.3 — secure-credential-routes spec).
//!
//! Strategy:
//! - Build a minimal axum Router with just the `/credentials` route backed
//!   by a real AppState that has `secret = Some("test-secret")`.
//! - Bind to a random port and start the server in a background task.
//! - Issue `GET /credentials` without the header → expect 401.
//! - Issue `GET /credentials` with the correct header → expect 200 (empty pool).

use std::sync::Arc;
use std::time::Duration;

use axum::{Router, routing::get};
use tokio::net::TcpListener;

use nexus_agent::cron_state::CronState;
use nexus_agent::environment::EnvironmentCache;
use nexus_agent::events::EventBroadcaster;
use nexus_agent::failures::FailureBuffer;
use nexus_agent::health::HealthCollector;
use nexus_agent::http_handlers::{AppState, credentials_handler};
use nexus_agent::registry::SessionRegistry;
use nexus_agent::services::command_registry::CommandRegistry;
use nexus_agent::services::credential_pool::CredentialPoolService;
use nexus_agent::services::project_status::ProjectStatusCache;
use nexus_agent::shutdown::ShutdownCoordinator;
use nexus_core::db::NexusDb;
use nexus_core::project_registry::ProjectRegistry;

/// Build a minimal `AppState` suitable for credential handler tests.
///
/// All unused services are given their cheapest valid defaults.
/// The `secret` field is set to `Some("test-secret")` so that
/// `validate_secret` requires the `X-Nexus-Secret` header.
async fn build_test_app_state() -> AppState {
    let broadcaster = Arc::new(EventBroadcaster::new(64));
    let registry = Arc::new(SessionRegistry::new(Arc::clone(&broadcaster)));
    let coordinator = Arc::new(ShutdownCoordinator::new());
    let http_client = reqwest::Client::new();

    // HealthCollector with a very long interval — tests don't need refreshes.
    let health = HealthCollector::spawn(
        Duration::from_secs(3600),
        http_client.clone(),
        String::new(),
        coordinator.token(),
    );

    let db = Arc::new(NexusDb::open_in_memory().expect("open in-memory DB for test"));
    db.migrate().expect("migrate test DB");

    let credential_pool = CredentialPoolService::new(http_client.clone()).pool();

    AppState {
        registry,
        health,
        environment_cache: Arc::new(EnvironmentCache::new()),
        failure_buffer: FailureBuffer::new(Arc::clone(&db)),
        cron_state: CronState::new(),
        agent_name: "test-agent".to_string(),
        agent_host: "localhost".to_string(),
        started_at: std::time::Instant::now(),
        project_registry: ProjectRegistry::load_empty(),
        status_cache: ProjectStatusCache::new(Duration::from_secs(60)),
        command_registry: CommandRegistry::with_default_dir(),
        // Secret required — unauthenticated requests must receive 401.
        secret: Some("test-secret".to_string()),
        http_client,
        credential_pool,
        db,
        projects_dir: "/tmp".to_string(),
    }
}

/// Bind a random port and spawn the axum server in a background task.
/// Returns the base URL for the bound server.
async fn start_test_http_server() -> String {
    let app_state = build_test_app_state().await;

    let app = Router::new()
        .route("/credentials", get(credentials_handler))
        .with_state(app_state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test server");
    let addr = listener.local_addr().expect("local_addr");

    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("credentials auth test server failed");
    });

    format!("http://127.0.0.1:{}", addr.port())
}

#[tokio::test]
async fn test_get_credentials_without_header_returns_401() {
    let base_url = start_test_http_server().await;

    let client = reqwest::Client::new();

    // No X-Nexus-Secret header — must return 401.
    let resp = client
        .get(format!("{base_url}/credentials"))
        .send()
        .await
        .expect("GET /credentials (no header)");

    assert_eq!(
        resp.status().as_u16(),
        401,
        "GET /credentials without X-Nexus-Secret must return 401"
    );
}

#[tokio::test]
async fn test_get_credentials_with_correct_header_returns_200() {
    let base_url = start_test_http_server().await;

    let client = reqwest::Client::new();

    // Correct secret — must pass the auth check and return 200 (empty pool).
    let resp = client
        .get(format!("{base_url}/credentials"))
        .header("x-nexus-secret", "test-secret")
        .send()
        .await
        .expect("GET /credentials (with header)");

    assert_eq!(
        resp.status().as_u16(),
        200,
        "GET /credentials with correct X-Nexus-Secret must return 200"
    );
}

#[tokio::test]
async fn test_get_credentials_with_wrong_header_returns_401() {
    let base_url = start_test_http_server().await;

    let client = reqwest::Client::new();

    // Wrong secret — must return 401.
    let resp = client
        .get(format!("{base_url}/credentials"))
        .header("x-nexus-secret", "wrong-secret")
        .send()
        .await
        .expect("GET /credentials (wrong header)");

    assert_eq!(
        resp.status().as_u16(),
        401,
        "GET /credentials with wrong X-Nexus-Secret must return 401"
    );
}
