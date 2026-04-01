//! Command registry handlers (list, list by namespace, run).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct ListCommandsQuery {
    pub namespace: Option<String>,
    pub tier: Option<String>,
}

/// GET /commands — list all discovered commands.
pub async fn list_commands_handler(
    State(state): State<AppState>,
    Query(query): Query<ListCommandsQuery>,
) -> Json<serde_json::Value> {
    let namespace = query.namespace.as_deref();
    let tier = query.tier.as_deref().and_then(|t| match t {
        "status" => Some(nexus_core::command::CommandTier::Status),
        "analysis" => Some(nexus_core::command::CommandTier::Analysis),
        "action" => Some(nexus_core::command::CommandTier::Action),
        _ => None,
    });

    let commands = state.command_registry.list(namespace, tier).await;
    Json(serde_json::json!({ "commands": commands }))
}

/// GET /commands/:namespace — list commands in a specific namespace.
pub async fn list_commands_by_namespace_handler(
    Path(namespace): Path<String>,
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let commands = state.command_registry.list(Some(&namespace), None).await;
    Json(serde_json::json!({ "namespace": namespace, "commands": commands }))
}

#[derive(Deserialize)]
pub struct RunCommandBody {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// POST /project/:code/run — accept a command execution request for a project.
///
/// When a shared secret is configured (via `secret` in agents.toml or the
/// `NEXUS_SECRET` env var), requests must include an `X-Nexus-Secret` header
/// with the matching value. Requests without a valid header receive 401.
pub async fn run_command_handler(
    Path(code): Path<String>,
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<RunCommandBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Shared-secret auth gate.
    if let Some(ref expected) = state.secret {
        let provided = headers.get("x-nexus-secret").and_then(|v| v.to_str().ok());
        match provided {
            Some(val) if val == expected => {} // OK
            _ => {
                return Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string()));
            }
        }
    }

    state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;

    state
        .command_registry
        .get(&body.command)
        .await
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("unknown command: {}", body.command),
            )
        })?;

    let prompt = if body.args.is_empty() {
        format!("/{}", body.command)
    } else {
        format!("/{} {}", body.command, body.args.join(" "))
    };

    Ok(Json(serde_json::json!({
        "status": "accepted",
        "project": code,
        "command": body.command,
        "prompt": prompt,
        "note": "Use gRPC RunProjectCommand for streaming execution"
    })))
}

/// Validate the `X-Nexus-Secret` header against the configured secret.
///
/// Returns `Ok(())` if no secret is configured (open access) or the header
/// matches. Returns `Err((401, "unauthorized"))` otherwise.
pub fn validate_secret(
    expected: &Option<String>,
    headers: &axum::http::HeaderMap,
) -> Result<(), (StatusCode, String)> {
    if let Some(secret) = expected {
        let provided = headers.get("x-nexus-secret").and_then(|v| v.to_str().ok());
        match provided {
            Some(val) if val == secret => Ok(()),
            _ => Err((StatusCode::UNAUTHORIZED, "unauthorized".to_string())),
        }
    } else {
        Ok(())
    }
}
