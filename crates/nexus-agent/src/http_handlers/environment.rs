//! GET /environment handler.

use axum::Json;
use axum::extract::State;

use crate::environment::EnvironmentResponse;

use super::AppState;

/// GET /environment — return dependency, config, and service checks.
pub async fn environment_handler(State(state): State<AppState>) -> Json<EnvironmentResponse> {
    let uptime_seconds = state.started_at.elapsed().as_secs();
    Json(state.environment_cache.get(uptime_seconds).await)
}
