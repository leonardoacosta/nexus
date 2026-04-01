//! Project status handlers (list, detail, beads, git, specs).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct ProjectStatusQuery {
    pub fresh: Option<bool>,
}

/// GET /project/:code/status — return aggregated beads + git + specs status.
pub async fn project_status_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    serde_json::to_value(&status)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// GET /project/:code/beads — return beads status only.
pub async fn project_beads_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    serde_json::to_value(&status.beads)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// GET /project/:code/git — return git status only.
pub async fn project_git_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    serde_json::to_value(&status.git)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

/// GET /project/:code/specs — return openspec status only.
pub async fn project_specs_handler(
    Path(code): Path<String>,
    Query(query): Query<ProjectStatusQuery>,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let project = state
        .project_registry
        .resolve(&code)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("unknown project: {code}")))?;
    let status = state
        .status_cache
        .get(&code, &project.cwd, query.fresh.unwrap_or(false))
        .await;
    serde_json::to_value(&status.spec)
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}
