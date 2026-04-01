//! POST /hooks handler for CC session events.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use super::AppState;

/// Incoming hook event payload — dispatched by `hook_event_name` or `event` field.
#[derive(Debug, Deserialize)]
pub struct HookEventPayload {
    /// Primary discriminant (preferred).
    #[serde(default)]
    pub hook_event_name: Option<String>,
    /// Fallback discriminant.
    #[serde(default)]
    pub event: Option<String>,

    // Fields for session_start
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub cc_session_id: Option<String>,
    #[serde(default)]
    pub tmux_target: Option<String>,

    // Fields for session_summary
    #[serde(default)]
    pub tool_counts: Option<std::collections::HashMap<String, u32>>,
    #[serde(default)]
    pub failure_count: Option<u32>,
    #[serde(default)]
    pub compaction_count: Option<u32>,
    #[serde(default)]
    pub agent_spawns: Option<u32>,
    #[serde(default)]
    pub duration_ms: Option<u64>,

    // Fields for stop_failure
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HookResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// POST /hooks — receive CC session events via HTTP.
pub async fn hooks_handler(
    State(state): State<AppState>,
    Json(payload): Json<HookEventPayload>,
) -> Result<Json<HookResponse>, (StatusCode, Json<HookResponse>)> {
    let event_name = payload
        .hook_event_name
        .as_deref()
        .or(payload.event.as_deref())
        .unwrap_or("unknown");

    match event_name {
        "session_start" => {
            let session_id = payload.session_id.clone().unwrap_or_default();
            if session_id.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(HookResponse {
                        status: "error".into(),
                        message: Some("session_start requires session_id".into()),
                    }),
                ));
            }

            let mut session = nexus_core::session::Session::new(
                payload.pid.unwrap_or(0),
                payload.cwd.clone().unwrap_or_default(),
            );
            session.id = session_id;
            session.project = payload.project.clone();
            session.branch = payload.branch.clone();
            session.model = payload.model.clone();
            session.cc_session_id = payload.cc_session_id.clone();

            let is_new = state
                .registry
                .register_adhoc(session, payload.tmux_target.clone())
                .await;

            Ok(Json(HookResponse {
                status: "ok".into(),
                message: Some(if is_new {
                    "session registered".into()
                } else {
                    "session already registered".into()
                }),
            }))
        }

        "session_stop" | "stop_failure" | "stop_success" => {
            let session_id = payload.session_id.clone().unwrap_or_default();
            if session_id.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(HookResponse {
                        status: "error".into(),
                        message: Some("session_stop requires session_id".into()),
                    }),
                ));
            }

            let removed = state.registry.unregister(&session_id).await;

            Ok(Json(HookResponse {
                status: "ok".into(),
                message: Some(if removed {
                    "session unregistered".into()
                } else {
                    "session not found".into()
                }),
            }))
        }

        "session_summary" => {
            let session_id = payload.session_id.clone().unwrap_or_default();
            if session_id.is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(HookResponse {
                        status: "error".into(),
                        message: Some("session_summary requires session_id".into()),
                    }),
                ));
            }

            let summary = crate::registry::SessionSummaryData {
                tool_counts: payload.tool_counts.clone().unwrap_or_default(),
                failure_count: payload.failure_count.unwrap_or(0),
                compaction_count: payload.compaction_count.unwrap_or(0),
                agent_spawns: payload.agent_spawns.unwrap_or(0),
                duration_ms: payload.duration_ms.unwrap_or(0),
                model: payload.model.clone(),
                session_id: session_id.clone(),
                project: payload.project.clone(),
                received_at: chrono::Utc::now(),
            };

            state.registry.store_session_summary(summary).await;

            Ok(Json(HookResponse {
                status: "ok".into(),
                message: Some("summary stored".into()),
            }))
        }

        "session_heartbeat" => {
            let session_id = payload.session_id.clone().unwrap_or_default();
            if !session_id.is_empty() {
                state.registry.heartbeat(&session_id).await;
            }

            Ok(Json(HookResponse {
                status: "ok".into(),
                message: None,
            }))
        }

        _ => {
            tracing::debug!(event = %event_name, "unknown hook event, ignoring");
            Ok(Json(HookResponse {
                status: "ok".into(),
                message: Some(format!("unknown event: {}", event_name)),
            }))
        }
    }
}
