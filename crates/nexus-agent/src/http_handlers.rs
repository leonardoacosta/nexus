//! Axum HTTP handler functions and associated request/response types.
//!
//! All axum handlers that were previously inline in `main.rs` live here.
//! The `AppState` struct (shared state injected by axum) and its supporting
//! types are also defined here so `main.rs` only needs to import from this
//! module.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use nexus_core::api::HealthResponse;
use nexus_core::project_registry::ProjectRegistry;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::cron_state::{CronResponse, CronState};
use crate::environment::{EnvironmentCache, EnvironmentResponse};
use crate::failures::{FailureBuffer, HttpFailuresResponse};
use crate::health::HealthCollector;
use crate::registry::SessionRegistry;
use crate::services::command_registry::CommandRegistry;
use crate::services::project_status::ProjectStatusCache;

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

/// Shared state passed to axum HTTP handlers via `State<AppState>`.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<SessionRegistry>,
    pub health: HealthCollector,
    pub environment_cache: Arc<EnvironmentCache>,
    pub failure_buffer: FailureBuffer,
    pub cron_state: CronState,
    pub agent_name: String,
    pub agent_host: String,
    pub started_at: std::time::Instant,
    pub project_registry: ProjectRegistry,
    pub status_cache: ProjectStatusCache,
    pub command_registry: CommandRegistry,
    /// Shared secret for authenticating sensitive endpoints.
    /// `None` means no auth required (backward compat).
    pub secret: Option<String>,
    /// Shared HTTP client for outbound requests (avoids per-request connection
    /// pool overhead).
    pub http_client: reqwest::Client,
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GET /statusline
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct StatuslineSession {
    id: String,
    project: Option<String>,
    status: String,
    model: Option<String>,
    spec: Option<String>,
    cwd: String,
    idle_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatuslineGit {
    branch: String,
    dirty: bool,
    ahead: u32,
    behind: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatuslineMachine {
    cpu_percent: f32,
    mem_percent: f32,
    load_1m: f32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatuslineResponse {
    sessions: Vec<StatuslineSession>,
    git: Option<StatuslineGit>,
    machine: StatuslineMachine,
    uptime_seconds: u64,
    daemon_count: usize,
}

/// GET /statusline — return compact JSON for the CC statusline script.
pub async fn statusline_handler(State(state): State<AppState>) -> Json<StatuslineResponse> {
    let machine = state.health.get().await;
    let sessions = state.registry.get_all().await;

    let statusline_sessions: Vec<StatuslineSession> = sessions
        .iter()
        .map(|s| StatuslineSession {
            id: s.id.clone(),
            project: s.project.clone(),
            status: format!("{:?}", s.status).to_lowercase(),
            model: s.model.clone(),
            spec: s.spec.clone(),
            cwd: s.cwd.clone(),
            idle_seconds: s.idle_seconds(),
        })
        .collect();

    let daemon_count = statusline_sessions.len();

    let mem_percent = if machine.memory_total_gb > 0.0 {
        (machine.memory_used_gb / machine.memory_total_gb) * 100.0
    } else {
        0.0
    };

    let git = get_git_status_cached().await;

    Json(StatuslineResponse {
        sessions: statusline_sessions,
        git,
        machine: StatuslineMachine {
            cpu_percent: machine.cpu_percent,
            mem_percent,
            load_1m: machine.load_avg[0],
        },
        uptime_seconds: state.started_at.elapsed().as_secs(),
        daemon_count,
    })
}

/// Git status cache — avoids shelling out on every statusline request.
/// Refreshes every 5 seconds at most.
static GIT_STATUS_CACHE: std::sync::OnceLock<tokio::sync::Mutex<GitStatusCache>> =
    std::sync::OnceLock::new();

struct GitStatusCache {
    value: Option<StatuslineGit>,
    refreshed_at: std::time::Instant,
}

async fn get_git_status_cached() -> Option<StatuslineGit> {
    const TTL: Duration = Duration::from_secs(5);

    let mutex = GIT_STATUS_CACHE.get_or_init(|| {
        tokio::sync::Mutex::new(GitStatusCache {
            value: None,
            refreshed_at: std::time::Instant::now()
                .checked_sub(TTL + Duration::from_secs(1))
                .unwrap_or(std::time::Instant::now()),
        })
    });

    let mut cache = mutex.lock().await;
    if cache.refreshed_at.elapsed() >= TTL {
        cache.value = fetch_git_status().await;
        cache.refreshed_at = std::time::Instant::now();
    }
    cache.value.clone()
}

/// Shell out to git to collect branch, dirty flag, ahead/behind counts.
async fn fetch_git_status() -> Option<StatuslineGit> {
    let branch_out = tokio::process::Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .await
        .ok()?;
    if !branch_out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return None;
    }

    let status_out = tokio::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .await
        .ok()?;
    let dirty = !status_out.stdout.is_empty();

    let (ahead, behind) = if let Ok(rev_out) = tokio::process::Command::new("git")
        .args(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
        .output()
        .await
    {
        if rev_out.status.success() {
            let s = String::from_utf8_lossy(&rev_out.stdout);
            let parts: Vec<&str> = s.trim().split_whitespace().collect();
            if parts.len() == 2 {
                let behind = parts[0].parse::<u32>().unwrap_or(0);
                let ahead = parts[1].parse::<u32>().unwrap_or(0);
                (ahead, behind)
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    Some(StatuslineGit {
        branch,
        dirty,
        ahead,
        behind,
    })
}

// ---------------------------------------------------------------------------
// GET /recommend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recommendation {
    id: String,
    title: String,
    score: i32,
    reason: String,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendContext {
    project: String,
    active_spec: Option<String>,
    session_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendResponse {
    recommendations: Vec<Recommendation>,
    context: RecommendContext,
}

struct RecommendCache {
    response: Option<RecommendResponse>,
    refreshed_at: Instant,
}

static RECOMMEND_CACHE: std::sync::OnceLock<Mutex<RecommendCache>> = std::sync::OnceLock::new();

/// GET /recommend — return scored work recommendations.
pub async fn recommend_handler(State(state): State<AppState>) -> Json<RecommendResponse> {
    const TTL: Duration = Duration::from_secs(30);

    let session_count = state.registry.get_all().await.len();

    let mutex = RECOMMEND_CACHE.get_or_init(|| {
        Mutex::new(RecommendCache {
            response: None,
            refreshed_at: Instant::now()
                .checked_sub(TTL + Duration::from_secs(1))
                .unwrap_or(Instant::now()),
        })
    });

    let mut cache = mutex.lock().await;

    if cache.refreshed_at.elapsed() < TTL {
        if let Some(ref mut resp) = cache.response {
            resp.context.session_count = session_count;
            return Json(resp.clone());
        }
    }

    let response = build_recommendations(session_count, &state.failure_buffer).await;
    cache.response = Some(response.clone());
    cache.refreshed_at = Instant::now();

    Json(response)
}

#[derive(Debug, Deserialize, Default)]
struct MasterContext {
    #[serde(default)]
    project: MasterContextProject,
    #[serde(default)]
    state: MasterContextState,
}

#[derive(Debug, Deserialize, Default)]
struct MasterContextProject {
    #[serde(default)]
    name: String,
    #[serde(default)]
    scope: String,
}

#[derive(Debug, Deserialize, Default)]
struct MasterContextState {
    #[serde(default)]
    active_spec: String,
}

#[derive(Debug, Deserialize)]
struct BeadsReadyItem {
    id: String,
    title: String,
    #[serde(default = "default_priority")]
    priority: i32,
    #[serde(default)]
    issue_type: String,
    #[serde(default)]
    created_at: String,
}

fn default_priority() -> i32 {
    4
}

async fn build_recommendations(session_count: usize, failure_buffer: &FailureBuffer) -> RecommendResponse {
    let (bd_result, context_result) = tokio::join!(fetch_bd_ready(), fetch_master_context());

    let ready_items = bd_result.unwrap_or_default();
    let context = context_result.unwrap_or_default();

    let project_name = if !context.project.name.is_empty() {
        context.project.name.clone()
    } else if !context.project.scope.is_empty() {
        context.project.scope.trim_start_matches('@').to_string()
    } else {
        String::new()
    };

    let active_spec = if context.state.active_spec.is_empty() {
        None
    } else {
        Some(context.state.active_spec.clone())
    };

    let mut recommendations: Vec<Recommendation> = Vec::new();

    if let Some(failure_rec) = check_failure_spike(failure_buffer).await {
        recommendations.push(failure_rec);
    }

    let now_epoch = chrono::Utc::now().timestamp();

    for item in &ready_items {
        let mut score: i32;
        let mut reasons: Vec<String> = Vec::new();

        match item.priority {
            0 => {
                score = 100;
                reasons.push("P0 broken".into());
            }
            1 => {
                score = 80;
                reasons.push("P1 critical".into());
            }
            2 => {
                score = 60;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
            3 => {
                score = 40;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
            _ => {
                score = 20;
                reasons.push(format!("P{} {}", item.priority, &item.issue_type));
            }
        }

        if !project_name.is_empty() {
            let prefix = format!("{}-", project_name);
            if item.id.starts_with(&prefix) {
                score += 25;
                reasons.push("same project".into());
            }
        }

        if let Some(ref spec) = active_spec {
            if !spec.is_empty() && item.title.to_lowercase().contains(&spec.to_lowercase()) {
                score += 30;
                reasons.push("active spec".into());
            }
        }

        if !item.created_at.is_empty() {
            if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&item.created_at) {
                let age_days = (now_epoch - created.timestamp()) / 86400;
                if age_days > 7 {
                    score += 5;
                    reasons.push("stale >7d".into());
                }
            }
        }

        recommendations.push(Recommendation {
            id: item.id.clone(),
            title: item.title.clone(),
            score,
            reason: reasons.join(", "),
            item_type: if item.issue_type.is_empty() {
                "task".into()
            } else {
                item.issue_type.clone()
            },
        });
    }

    recommendations.sort_by(|a, b| b.score.cmp(&a.score));

    RecommendResponse {
        recommendations,
        context: RecommendContext {
            project: project_name,
            active_spec,
            session_count,
        },
    }
}

async fn fetch_bd_ready() -> Option<Vec<BeadsReadyItem>> {
    let output = tokio::process::Command::new("bd")
        .args(["ready", "--json"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Vec<BeadsReadyItem>>(&stdout).ok()
}

async fn fetch_master_context() -> Option<MasterContext> {
    let home = nexus_core::paths::home_dir();
    let path = home.join(".claude/scripts/state/master-context.json");
    let contents = tokio::fs::read_to_string(&path).await.ok()?;
    serde_json::from_str::<MasterContext>(&contents).ok()
}

async fn check_failure_spike(failure_buffer: &FailureBuffer) -> Option<Recommendation> {
    let summary = failure_buffer.query_http(1).await;

    if summary.total > 50 {
        Some(Recommendation {
            id: String::new(),
            title: format!("Investigate tool failures ({} in last 24h)", summary.total),
            score: 30,
            reason: format!("failure spike: {} failures/day", summary.total),
            item_type: "investigation".into(),
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// GET /environment
// ---------------------------------------------------------------------------

/// GET /environment — return dependency, config, and service checks.
pub async fn environment_handler(State(state): State<AppState>) -> Json<EnvironmentResponse> {
    let uptime_seconds = state.started_at.elapsed().as_secs();
    Json(state.environment_cache.get(uptime_seconds).await)
}

// ---------------------------------------------------------------------------
// GET /failures
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct FailuresParams {
    #[serde(default = "default_failures_days")]
    pub days: u32,
}

fn default_failures_days() -> u32 {
    7
}

/// GET /failures — return aggregated tool failure data.
pub async fn failures_handler(
    State(state): State<AppState>,
    Query(params): Query<FailuresParams>,
) -> Json<HttpFailuresResponse> {
    Json(state.failure_buffer.query_http(params.days).await)
}

// ---------------------------------------------------------------------------
// GET /cron
// ---------------------------------------------------------------------------

/// GET /cron — return cron job run history.
pub async fn cron_handler(State(state): State<AppState>) -> Json<CronResponse> {
    let snapshot = state.cron_state.snapshot().await;
    Json(CronResponse {
        jobs: snapshot.into_iter().map(|(k, v)| (k, v.into())).collect(),
    })
}

// ---------------------------------------------------------------------------
// Project status handlers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command registry handlers
// ---------------------------------------------------------------------------

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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn no_secret_configured_allows_all_requests() {
        let secret: Option<String> = None;
        let headers = HeaderMap::new();
        assert!(validate_secret(&secret, &headers).is_ok());
    }

    #[test]
    fn secret_configured_rejects_missing_header() {
        let secret = Some("my-secret".to_string());
        let headers = HeaderMap::new();
        let err = validate_secret(&secret, &headers).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn secret_configured_rejects_wrong_header() {
        let secret = Some("my-secret".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("x-nexus-secret", "wrong-secret".parse().unwrap());
        let err = validate_secret(&secret, &headers).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn secret_configured_accepts_valid_header() {
        let secret = Some("my-secret".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("x-nexus-secret", "my-secret".parse().unwrap());
        assert!(validate_secret(&secret, &headers).is_ok());
    }
}
