//! Spec CRUD handlers (list, detail, approve, reject, read, status, all).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use super::AppState;

// ---------------------------------------------------------------------------
// GET /specs/all — cross-project aggregate spec + beads status
// ---------------------------------------------------------------------------

/// Per-project spec + beads summary in the cross-project response.
#[derive(Debug, Serialize)]
pub struct ProjectSpecStatus {
    pub code: String,
    pub name: String,
    pub specs: Vec<nexus_core::project_registry::SpecSnapshot>,
    pub beads: Option<BeadsSummary>,
}

/// Summary of beads state for a project.
#[derive(Debug, Serialize)]
pub struct BeadsSummary {
    pub open: u32,
    pub closed: u32,
    pub ready: u32,
}

/// Top-level response for `GET /specs/all`.
#[derive(Debug, Serialize)]
pub struct AllSpecsResponse {
    pub projects: Vec<ProjectSpecStatus>,
}

/// GET /specs/all — return aggregated spec + beads status for all registered projects.
///
/// Reads from the `ProjectStatusCache` for each project returned by
/// `ProjectRegistry::all()`. If a project has no cached data, it is included
/// with empty specs and no beads summary (the background `SpecWatcherService`
/// will populate it on the next poll cycle).
pub async fn specs_all_handler(State(state): State<AppState>) -> Json<AllSpecsResponse> {
    let all_projects = state.project_registry.all();
    let mut projects: Vec<ProjectSpecStatus> = Vec::with_capacity(all_projects.len());

    for project in &all_projects {
        let cached = state.status_cache.get_cached(&project.code).await;

        let (specs, beads) = match cached {
            Some(status) => {
                let spec_snapshots: Vec<nexus_core::project_registry::SpecSnapshot> = status
                    .spec
                    .active_changes
                    .iter()
                    .map(|name| nexus_core::project_registry::SpecSnapshot {
                        name: name.clone(),
                        status: "active".to_string(),
                        completed_tasks: 0,
                        total_tasks: 0,
                        last_modified: None,
                    })
                    .collect();

                let beads_summary = BeadsSummary {
                    open: status.beads.open_count.max(0) as u32,
                    closed: 0, // Not tracked by the collector
                    ready: status.beads.ready_count.max(0) as u32,
                };

                (spec_snapshots, Some(beads_summary))
            }
            None => (vec![], None),
        };

        projects.push(ProjectSpecStatus {
            code: project.code.clone(),
            name: project.name.clone(),
            specs,
            beads,
        });
    }

    Json(AllSpecsResponse { projects })
}

// ---------------------------------------------------------------------------
// GET /specs — list specs from DB with optional status filter
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ListSpecsQuery {
    /// Comma-separated status values to filter by (e.g. `?status=unread,read`).
    pub status: Option<String>,
}

/// GET /specs — return specs from DB with optional status filter.
pub async fn list_specs_handler(
    State(state): State<AppState>,
    Query(query): Query<ListSpecsQuery>,
) -> Json<Vec<nexus_core::db::SpecRecord>> {
    let filter_strings: Option<Vec<String>> = query.status.map(|s| {
        s.split(',')
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect()
    });

    let result = match &filter_strings {
        Some(statuses) => {
            let refs: Vec<&str> = statuses.iter().map(|s| s.as_str()).collect();
            state.db.list_specs(Some(&refs))
        }
        None => state.db.list_specs(None),
    };

    Json(result.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// GET /specs/:project/:name — single spec detail
// ---------------------------------------------------------------------------

/// GET /specs/:project/:name — return a single spec record.
pub async fn get_spec_handler(
    Path((project, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<nexus_core::db::SpecRecord>, (StatusCode, String)> {
    state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("spec {project}/{name} not found"),
            )
        })
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/approve
// ---------------------------------------------------------------------------

/// POST /specs/:project/:name/approve — approve a spec.
pub async fn approve_spec_handler(
    Path((project, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<nexus_core::db::SpecRecord>, (StatusCode, String)> {
    let spec = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("spec {project}/{name} not found"),
            )
        })?;

    // Reject if already applied or archived.
    if spec.status == "applied" || spec.status == "archived" {
        return Err((
            StatusCode::CONFLICT,
            format!("spec {project}/{name} is already {}", spec.status),
        ));
    }

    state
        .db
        .update_spec_status(&project, &name, "approved")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Log audit event (best-effort).
    let _ = state
        .db
        .log_event("spec_approved", "http", &format!("{project}/{name}"), None);

    let updated = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "spec disappeared after update".to_string(),
            )
        })?;

    Ok(Json(updated))
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/reject
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
pub struct RejectBody {
    pub reason: Option<String>,
}

/// POST /specs/:project/:name/reject — reject a spec.
pub async fn reject_spec_handler(
    Path((project, name)): Path<(String, String)>,
    State(state): State<AppState>,
    body: Option<Json<RejectBody>>,
) -> Result<Json<nexus_core::db::SpecRecord>, (StatusCode, String)> {
    let spec = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("spec {project}/{name} not found"),
            )
        })?;

    // Reject if already applied or archived.
    if spec.status == "applied" || spec.status == "archived" {
        return Err((
            StatusCode::CONFLICT,
            format!("spec {project}/{name} is already {}", spec.status),
        ));
    }

    state
        .db
        .update_spec_status(&project, &name, "rejected")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // If a reason was provided, update the rejection_reason directly.
    if let Some(Json(RejectBody {
        reason: Some(ref reason),
    })) = body
    {
        let reason = reason.clone();
        let project_c = project.clone();
        let name_c = name.clone();
        let _ = state.db.write(move |conn| {
            let id = format!("{project_c}/{name_c}");
            conn.execute(
                "UPDATE specs SET rejection_reason = ?1 WHERE id = ?2",
                [&reason, &id],
            )?;
            Ok(())
        });
    }

    // Log audit event (best-effort).
    let reason_text = body
        .as_ref()
        .and_then(|b| b.reason.as_deref())
        .unwrap_or("no reason given");
    let _ = state.db.log_event(
        "spec_rejected",
        "http",
        &format!("{project}/{name}"),
        Some(reason_text),
    );

    let updated = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "spec disappeared after update".to_string(),
            )
        })?;

    Ok(Json(updated))
}

// ---------------------------------------------------------------------------
// POST /specs/:project/:name/read — mark a spec as read
// ---------------------------------------------------------------------------

/// POST /specs/:project/:name/read — mark a spec as read.
pub async fn read_spec_handler(
    Path((project, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<nexus_core::db::SpecRecord>, (StatusCode, String)> {
    let spec = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("spec {project}/{name} not found"),
            )
        })?;

    // Only mark as read if currently unread.
    if spec.status != "unread" {
        // Already read or in a later state — return current record.
        return Ok(Json(spec));
    }

    state
        .db
        .update_spec_status(&project, &name, "read")
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Log audit event (best-effort).
    let _ = state
        .db
        .log_event("spec_read", "http", &format!("{project}/{name}"), None);

    let updated = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "spec disappeared after update".to_string(),
            )
        })?;

    Ok(Json(updated))
}

// ---------------------------------------------------------------------------
// GET /specs/:project/:name/status — approval gate status check
// ---------------------------------------------------------------------------

/// Simple response for the approval gate status endpoint.
#[derive(Debug, Serialize)]
pub struct SpecStatusResponse {
    pub status: String,
}

/// GET /specs/:project/:name/status — return just the current status.
///
/// This is the endpoint that `/apply` calls to check whether a spec has been
/// approved before proceeding with implementation.
pub async fn spec_status_handler(
    Path((project, name)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Result<Json<SpecStatusResponse>, (StatusCode, String)> {
    let spec = state
        .db
        .get_spec(&project, &name)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                format!("spec {project}/{name} not found"),
            )
        })?;

    Ok(Json(SpecStatusResponse {
        status: spec.status,
    }))
}
