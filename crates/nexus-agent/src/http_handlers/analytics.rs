//! Analytics handlers — health timeseries, spec velocity, credentials, git, lifecycle, cron.

use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use super::AppState;

// ---------------------------------------------------------------------------
// GET /analytics/health
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsHealthQuery {
    pub hours: Option<u32>,
}

/// GET /analytics/health?hours=N — return health timeseries samples.
pub async fn analytics_health_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsHealthQuery>,
) -> Json<Vec<nexus_core::db::HealthSampleRecord>> {
    let hours = query.hours.unwrap_or(24);
    let since = chrono::Utc::now() - chrono::Duration::hours(hours as i64);
    let result = state
        .db
        .query_health_samples(Some(&since.to_rfc3339()), 10_000);
    Json(result.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// GET /analytics/specs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsSpecsQuery {
    pub project: Option<String>,
    pub days: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AnalyticsSpecsResponse {
    pub snapshots: Vec<nexus_core::db::SpecSnapshotRecord>,
}

/// GET /analytics/specs?project=X&days=N — return spec delivery velocity data.
pub async fn analytics_specs_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsSpecsQuery>,
) -> Json<AnalyticsSpecsResponse> {
    let days = query.days.unwrap_or(30);
    let limit = (days * 24 * 2) as u32; // ~2 samples/hr * 24hr * days

    let snapshots = match &query.project {
        Some(project) => state
            .db
            .query_spec_snapshots(project, limit)
            .unwrap_or_default(),
        None => {
            // Return all projects — query each registered project.
            let mut all = Vec::new();
            for proj in state.project_registry.all() {
                let mut snaps = state
                    .db
                    .query_spec_snapshots(&proj.code, limit)
                    .unwrap_or_default();
                all.append(&mut snaps);
            }
            all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
            all.truncate(limit as usize);
            all
        }
    };

    Json(AnalyticsSpecsResponse { snapshots })
}

// ---------------------------------------------------------------------------
// GET /analytics/credentials
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsCredentialsQuery {
    pub hours: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AnalyticsCredentialsResponse {
    pub polls: Vec<nexus_core::db::CredentialPollRecord>,
    pub swaps: Vec<nexus_core::db::CredentialSwapRecord>,
}

/// GET /analytics/credentials?hours=N — return credential usage analytics.
pub async fn analytics_credentials_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsCredentialsQuery>,
) -> Json<AnalyticsCredentialsResponse> {
    let hours = query.hours.unwrap_or(24);
    let limit = (hours * 12) as u32; // ~12 polls/hr max

    let polls = state
        .db
        .query_credential_polls(None, limit)
        .unwrap_or_default();
    let swaps = state.db.query_credential_swaps(limit).unwrap_or_default();

    Json(AnalyticsCredentialsResponse { polls, swaps })
}

// ---------------------------------------------------------------------------
// GET /analytics/git
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsGitQuery {
    pub project: Option<String>,
    pub limit: Option<u32>,
}

/// GET /analytics/git?project=X&limit=N — return git event history.
pub async fn analytics_git_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsGitQuery>,
) -> Json<Vec<nexus_core::db::GitEventRecord>> {
    let limit = query.limit.unwrap_or(200);
    let result = state.db.query_git_events(query.project.as_deref(), limit);
    Json(result.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// GET /analytics/lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsLifecycleQuery {
    pub limit: Option<u32>,
}

/// GET /analytics/lifecycle?limit=N — return agent lifecycle events.
pub async fn analytics_lifecycle_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsLifecycleQuery>,
) -> Json<Vec<nexus_core::db::AgentLifecycleRecord>> {
    let limit = query.limit.unwrap_or(100);
    let result = state.db.query_lifecycle_events(limit);
    Json(result.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// GET /analytics/cron
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyticsCronQuery {
    pub job: Option<String>,
    pub limit: Option<u32>,
}

/// GET /analytics/cron?job=X&limit=N — return cron run history from DB.
pub async fn analytics_cron_handler(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsCronQuery>,
) -> Json<Vec<nexus_core::db::CronRunRecord>> {
    let limit = query.limit.unwrap_or(100);
    let result = state.db.query_cron_runs(query.job.as_deref(), limit);
    Json(result.unwrap_or_default())
}
