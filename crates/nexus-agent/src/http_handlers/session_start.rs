use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::AppState;

#[derive(Deserialize)]
pub struct SessionStartBody {
    pub project: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct SessionStartResponse {
    pub session_name: String,
    pub started: bool,
}

pub async fn session_start_handler(
    State(_state): State<AppState>,
    Json(body): Json<SessionStartBody>,
) -> Result<Json<SessionStartResponse>, (StatusCode, Json<serde_json::Value>)> {
    // 1. Check tmux is available
    let tmux_check = std::process::Command::new("which").arg("tmux").output();
    match tmux_check {
        Ok(out) if out.status.success() => {}
        _ => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "tmux not found — install tmux on this agent"
                })),
            ));
        }
    }

    // 2. Validate path exists and is a directory
    if !Path::new(&body.path).is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("project path does not exist: {}", body.path)
            })),
        ));
    }

    // 3. Generate unique session name
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let session_name = format!("{}-{}", body.project, ts);

    // 4. Create tmux window
    let new_window = std::process::Command::new("tmux")
        .args(["new-window", "-d", "-c", &body.path, "-n", &session_name])
        .output()
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("tmux error: {e}") })),
            )
        })?;

    if !new_window.status.success() {
        let stderr = String::from_utf8_lossy(&new_window.stderr);
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("tmux new-window failed: {stderr}") })),
        ));
    }

    // 5. Send claude command
    let _ = std::process::Command::new("tmux")
        .args(["send-keys", "-t", &session_name, "claude", "Enter"])
        .output();

    Ok(Json(SessionStartResponse {
        session_name,
        started: true,
    }))
}
