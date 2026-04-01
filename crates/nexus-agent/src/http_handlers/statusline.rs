//! GET /statusline handler with git status caching.

use std::time::Duration;

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

use super::AppState;

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
            let parts: Vec<&str> = s.split_whitespace().collect();
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
