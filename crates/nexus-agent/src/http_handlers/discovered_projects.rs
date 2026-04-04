use std::path::Path;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use tokio::time::timeout;

use nexus_core::session::SessionStatus;

use super::AppState;

#[derive(Deserialize)]
pub struct DiscoveredProjectsQuery {
    pub depth: Option<u32>,
}

#[derive(serde::Serialize)]
struct DiscoveredProjectEntry {
    name: String,
    path: String,
    active_sessions: usize,
    total_sessions: usize,
}

fn is_project_dir(path: &Path) -> bool {
    path.join(".git").is_dir()
        || path.join("package.json").is_file()
        || path.join("Cargo.toml").is_file()
}

fn scan_recursive(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    results: &mut Vec<DiscoveredProjectEntry>,
) {
    if results.len() >= 200 {
        return;
    }

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Skip symlinks to prevent cycles.
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            dirs.push(entry.path());
        }
    }

    dirs.sort();

    for path in dirs {
        if results.len() >= 200 {
            break;
        }
        if is_project_dir(&path) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            results.push(DiscoveredProjectEntry {
                name,
                path: path.to_string_lossy().to_string(),
                active_sessions: 0,
                total_sessions: 0,
            });
        }
        // Recurse into subdirectories even if this dir is a project.
        if depth < max_depth {
            scan_recursive(&path, depth + 1, max_depth, results);
        }
    }
}

pub async fn discovered_projects_handler(
    State(state): State<AppState>,
    Query(query): Query<DiscoveredProjectsQuery>,
) -> Json<serde_json::Value> {
    let max_depth = query.depth.unwrap_or(1).clamp(1, 3);
    let projects_dir = std::path::PathBuf::from(&state.projects_dir);

    let scan_result = timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            let mut results: Vec<DiscoveredProjectEntry> = Vec::new();
            if projects_dir.is_dir() {
                scan_recursive(&projects_dir, 1, max_depth, &mut results);
            }
            results
        }),
    )
    .await;

    let mut projects = match scan_result {
        Ok(Ok(p)) => p,
        // Timeout or join error — return empty list.
        _ => Vec::new(),
    };

    // Merge with active session counts from registry.
    let sessions = state.registry.get_all().await;
    for project in &mut projects {
        project.active_sessions = sessions
            .iter()
            .filter(|s| {
                s.project.as_deref() == Some(project.name.as_str())
                    && s.status == SessionStatus::Active
            })
            .count();
        project.total_sessions = sessions
            .iter()
            .filter(|s| s.project.as_deref() == Some(project.name.as_str()))
            .count();
    }

    let truncated = projects.len() >= 200;

    Json(serde_json::json!({
        "projects": projects,
        "truncated": truncated,
    }))
}
