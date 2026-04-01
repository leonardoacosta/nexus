//! GET /recommend handler with recommendation engine.

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::failures::FailureBuffer;

use super::AppState;

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

    if cache.refreshed_at.elapsed() < TTL
        && let Some(ref mut resp) = cache.response
    {
        resp.context.session_count = session_count;
        return Json(resp.clone());
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

async fn build_recommendations(
    session_count: usize,
    failure_buffer: &FailureBuffer,
) -> RecommendResponse {
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

        if let Some(ref spec) = active_spec
            && !spec.is_empty()
            && item.title.to_lowercase().contains(&spec.to_lowercase())
        {
            score += 30;
            reasons.push("active spec".into());
        }

        if !item.created_at.is_empty()
            && let Ok(created) = chrono::DateTime::parse_from_rfc3339(&item.created_at)
        {
            let age_days = (now_epoch - created.timestamp()) / 86400;
            if age_days > 7 {
                score += 5;
                reasons.push("stale >7d".into());
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
