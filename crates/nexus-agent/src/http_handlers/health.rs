//! GET /health handler.

use axum::Json;
use axum::extract::State;
use nexus_core::health::MachineHealth;
use serde::{Deserialize, Serialize};

use super::AppState;

/// JSON body returned by `GET /health`.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    agent_name: String,
    agent_host: String,
    uptime_seconds: u64,
    session_count: usize,
    machine: Option<MachineHealth>,
}

/// GET /health — return JSON HealthResponse with cached machine metrics.
pub async fn health_handler(State(state): State<AppState>) -> Json<HealthResponse> {
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
