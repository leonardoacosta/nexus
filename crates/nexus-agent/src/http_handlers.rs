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
use crate::services::credential_pool::CredentialPool;
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
    /// Credential pool for OAuth credential rotation (shared with socket handler).
    pub credential_pool: Arc<CredentialPool>,
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
// GET /credentials
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowStatus {
    pub utilization: f32,
    pub resets_in_minutes: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountStatus {
    pub name: String,
    pub expired: bool,
    pub five_hour: Option<WindowStatus>,
    pub seven_day: Option<WindowStatus>,
    pub seconds_since_polled: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SwapInfo {
    pub debounce_active: bool,
    pub last_swap_account: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CredentialsResponse {
    pub active_account: Option<String>,
    pub accounts: Vec<AccountStatus>,
    pub swap: SwapInfo,
}

/// GET /credentials — return sanitized credential pool status (no tokens/paths).
pub async fn credentials_handler(State(state): State<AppState>) -> Json<CredentialsResponse> {
    let pool = &state.credential_pool;
    let now = chrono::Utc::now();

    let active = pool.active_account.read().await.clone();
    let accounts = pool.accounts.read().await;

    let account_statuses: Vec<AccountStatus> = accounts
        .iter()
        .map(|a| {
            let (five_hour, seven_day) = match &a.usage {
                Some(usage) => {
                    let fh = WindowStatus {
                        utilization: usage.five_hour.utilization,
                        resets_in_minutes: usage
                            .five_hour
                            .resets_at
                            .signed_duration_since(now)
                            .num_seconds() as f64
                            / 60.0,
                    };
                    let sd = WindowStatus {
                        utilization: usage.seven_day.utilization,
                        resets_in_minutes: usage
                            .seven_day
                            .resets_at
                            .signed_duration_since(now)
                            .num_seconds() as f64
                            / 60.0,
                    };
                    (Some(fh), Some(sd))
                }
                None => (None, None),
            };

            let seconds_since_polled = a
                .last_polled
                .map(|lp| now.signed_duration_since(lp).num_seconds());

            AccountStatus {
                name: a.name.clone(),
                expired: a.is_expired(),
                five_hour,
                seven_day,
                seconds_since_polled,
            }
        })
        .collect();

    let debounce_active = pool.is_debounce_active().await;
    let last_swap_account = pool.last_swap_account.read().await.clone();

    Json(CredentialsResponse {
        active_account: active,
        accounts: account_statuses,
        swap: SwapInfo {
            debounce_active,
            last_swap_account,
        },
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
// POST /hooks
// ---------------------------------------------------------------------------

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

    #[test]
    fn credentials_response_no_sensitive_fields() {
        let resp = CredentialsResponse {
            active_account: None,
            accounts: vec![],
            swap: SwapInfo {
                debounce_active: false,
                last_swap_account: None,
            },
        };
        let json = serde_json::to_value(&resp).unwrap();

        // Must not contain access_token or path fields
        let json_str = serde_json::to_string(&json).unwrap();
        assert!(!json_str.contains("access_token"));
        assert!(!json_str.contains("\"path\""));
    }

    #[test]
    fn credentials_response_empty_pool() {
        let resp = CredentialsResponse {
            active_account: None,
            accounts: vec![],
            swap: SwapInfo {
                debounce_active: false,
                last_swap_account: None,
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["active_account"], serde_json::Value::Null);
        assert_eq!(json["accounts"], serde_json::json!([]));
    }

    #[test]
    fn hook_payload_session_start_deserializes() {
        let json = r#"{
            "hook_event_name": "session_start",
            "session_id": "sess-123",
            "project": "nx",
            "cwd": "/home/user/dev/nx",
            "model": "opus",
            "pid": 12345
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.hook_event_name.as_deref(), Some("session_start"));
        assert_eq!(payload.session_id.as_deref(), Some("sess-123"));
        assert_eq!(payload.project.as_deref(), Some("nx"));
        assert_eq!(payload.pid, Some(12345));
    }

    #[test]
    fn hook_payload_stop_failure_deserializes() {
        let json = r#"{
            "event": "stop_failure",
            "session_id": "sess-456",
            "reason": "process crashed"
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.event.as_deref(), Some("stop_failure"));
        assert_eq!(payload.session_id.as_deref(), Some("sess-456"));
        assert_eq!(payload.reason.as_deref(), Some("process crashed"));
    }

    #[test]
    fn hook_payload_session_summary_deserializes() {
        let json = r#"{
            "hook_event_name": "session_summary",
            "session_id": "sess-789",
            "project": "oo",
            "tool_counts": {"Read": 5, "Write": 3},
            "failure_count": 1,
            "compaction_count": 0,
            "agent_spawns": 2,
            "duration_ms": 120000,
            "model": "opus"
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(
            payload.hook_event_name.as_deref(),
            Some("session_summary")
        );
        let tc = payload.tool_counts.as_ref().unwrap();
        assert_eq!(*tc.get("Read").unwrap(), 5);
        assert_eq!(*tc.get("Write").unwrap(), 3);
        assert_eq!(payload.failure_count, Some(1));
        assert_eq!(payload.agent_spawns, Some(2));
        assert_eq!(payload.duration_ms, Some(120000));
    }

    #[test]
    fn hook_payload_malformed_json_fails() {
        let json = "not json at all";
        let result = serde_json::from_str::<HookEventPayload>(json);
        assert!(result.is_err());
    }

    #[test]
    fn hook_payload_unknown_event_deserializes() {
        let json = r#"{"event": "some_future_event", "session_id": "x"}"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.event.as_deref(), Some("some_future_event"));
    }

    #[test]
    fn hook_payload_fallback_discriminant() {
        // When hook_event_name is absent, event is used
        let json = r#"{"event": "session_start", "session_id": "x"}"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert!(payload.hook_event_name.is_none());
        assert_eq!(payload.event.as_deref(), Some("session_start"));
    }

    #[test]
    fn credentials_response_with_accounts() {
        let resp = CredentialsResponse {
            active_account: Some("personal".to_string()),
            accounts: vec![AccountStatus {
                name: "personal".to_string(),
                expired: false,
                five_hour: Some(WindowStatus {
                    utilization: 0.45,
                    resets_in_minutes: 120.5,
                }),
                seven_day: Some(WindowStatus {
                    utilization: 0.72,
                    resets_in_minutes: 4320.0,
                }),
                seconds_since_polled: Some(30),
            }],
            swap: SwapInfo {
                debounce_active: true,
                last_swap_account: Some("work".to_string()),
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["active_account"], "personal");
        assert_eq!(json["accounts"].as_array().unwrap().len(), 1);
        assert_eq!(json["accounts"][0]["name"], "personal");
        assert!(!json["accounts"][0]["expired"].as_bool().unwrap());
        assert!(json["swap"]["debounce_active"].as_bool().unwrap());

        // Verify no sensitive data leakage
        let s = serde_json::to_string(&json).unwrap();
        assert!(!s.contains("access_token"));
        assert!(!s.contains("\"path\""));
    }
}
