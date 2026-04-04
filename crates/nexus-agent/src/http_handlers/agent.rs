use axum::Json;
use axum::extract::State;

use super::AppState;

/// GET /agent/self — return this agent's own configuration.
pub async fn agent_self_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "name": state.agent_name,
        "host": state.agent_host,
        "port": 7400,
        "role": "agent",
        "projects_dir": state.projects_dir,
    }))
}
