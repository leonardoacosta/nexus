use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;

use super::AppState;

#[derive(Deserialize)]
pub struct UpdateCommandBody {
    pub content: String,
}

/// PUT /commands/:name — atomically overwrite a command file.
///
/// `:name` is the full command name with `:` as separator (URL-encoded as %3A).
/// For example: `PUT /commands/audit%3Acode` updates `~/.claude/commands/audit/code.md`
pub async fn update_command_handler(
    Path(name): Path<String>,
    State(state): State<AppState>,
    Json(body): Json<UpdateCommandBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    // 1. Validate content is non-empty
    if body.content.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "content must not be empty" })),
        ));
    }

    // 2. Resolve the command file path
    let file_path = state.command_registry.get_path(&name).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": format!("command not found: {name}") })),
        )
    })?;

    // 3. Atomic write via tmp file + rename
    let tmp_path = file_path.with_extension("md.tmp");

    tokio::fs::write(&tmp_path, body.content.as_bytes())
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("write error: {e}") })),
            )
        })?;

    tokio::fs::rename(&tmp_path, &file_path)
        .await
        .map_err(|e| {
            // Clean up tmp on rename failure
            let _ = std::fs::remove_file(&tmp_path);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("rename error: {e}") })),
            )
        })?;

    // 4. Refresh the command registry so the updated description is reflected
    state.command_registry.refresh().await;

    Ok(Json(serde_json::json!({
        "name": name,
        "updated": true,
        "path": file_path.to_string_lossy(),
    })))
}
