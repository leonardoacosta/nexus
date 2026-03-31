//! Spec Watcher Service
//!
//! Proactively polls openspec + beads status across all registered projects,
//! detects state transitions (new/progress/complete/archived), emits TTS
//! notifications, and warms the [`ProjectStatusCache`].
//!
//! Design: 60-second poll interval, staggered batches of 3-5 projects with
//! 200ms inter-batch delay. Only projects that have an `openspec/` directory
//! are polled.

use crate::claude_utils::notify::send_notification;
use crate::services::project_status::{collect_all, ProjectStatusCache};
use crate::services::Service;
use anyhow::Result;
use nexus_core::project_registry::{ProjectPath, ProjectRegistry, SpecSnapshot};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info, warn};

/// How often to run a full poll cycle (seconds).
const POLL_INTERVAL_SECS: u64 = 60;

/// Max projects to poll in one batch before sleeping.
const BATCH_SIZE: usize = 4;

/// Delay between batches (milliseconds).
const BATCH_DELAY_MS: u64 = 200;

/// Subprocess timeout for `openspec list --json`.
const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(5);

/// Delay after collecting all events before sending a batched TTS notification.
const COALESCE_DELAY: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// A detected state change in a project's spec landscape.
#[derive(Debug)]
enum SpecEvent {
    /// A spec appeared that was not in the previous snapshot.
    NewSpec { project: String, name: String },
    /// A spec disappeared from the current snapshot.
    Removed { project: String, name: String },
    /// Task completion count increased.
    Progress {
        project: String,
        name: String,
        completed: u32,
        total: u32,
    },
    /// All tasks complete (was incomplete before).
    AllComplete { project: String, name: String },
}

impl SpecEvent {
    fn to_message(&self) -> String {
        match self {
            Self::NewSpec { project, name } => format!("New spec {} in {}", name, project),
            Self::Removed { project, name } => format!("{}: {} archived", project, name),
            Self::Progress {
                project,
                name,
                completed,
                total,
            } => format!("{}: {} progress {}/{}", project, name, completed, total),
            Self::AllComplete { project, name } => {
                format!("{}: {} all tasks complete", project, name)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/// Run `openspec list --json` in a project directory and parse the output into
/// `Vec<SpecSnapshot>`. Returns an empty vec on any failure.
async fn poll_project_specs(cwd: &Path) -> Vec<SpecSnapshot> {
    let openspec_dir = cwd.join("openspec");
    if !openspec_dir.exists() {
        return vec![];
    }

    let fut = async {
        let output = Command::new("openspec")
            .args(["list", "--json"])
            .current_dir(cwd)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                parse_spec_list(&stdout)
            }
            Ok(out) => {
                debug!(
                    cwd = %cwd.display(),
                    exit = ?out.status.code(),
                    "openspec list --json exited with non-zero status"
                );
                vec![]
            }
            Err(e) => {
                debug!(
                    cwd = %cwd.display(),
                    err = %e,
                    "openspec list --json IO error"
                );
                vec![]
            }
        }
    };

    match timeout(SUBPROCESS_TIMEOUT, fut).await {
        Ok(result) => result,
        Err(_) => {
            warn!(
                cwd = %cwd.display(),
                "openspec list --json timed out after 5s"
            );
            vec![]
        }
    }
}

/// Parse `openspec list --json` output into spec snapshots.
///
/// Expected shape:
/// ```json
/// [{ "name": "add-feature", "status": "active", "completedTasks": 3, "totalTasks": 10, "lastModified": "..." }]
/// ```
///
/// Handles both camelCase and snake_case keys, and missing fields gracefully.
fn parse_spec_list(json: &str) -> Vec<SpecSnapshot> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return vec![];
    };

    let Some(arr) = value.as_array() else {
        return vec![];
    };

    arr.iter()
        .filter_map(|item| {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                return None;
            }
            let status = item
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let completed_tasks = item
                .get("completedTasks")
                .or_else(|| item.get("completed_tasks"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let total_tasks = item
                .get("totalTasks")
                .or_else(|| item.get("total_tasks"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            let last_modified = item
                .get("lastModified")
                .or_else(|| item.get("last_modified"))
                .and_then(|v| v.as_str())
                .map(String::from);

            Some(SpecSnapshot {
                name,
                status,
                completed_tasks,
                total_tasks,
                last_modified,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/// Compare current snapshots against previous snapshots and return events.
fn detect_changes(
    project: &str,
    previous: &[SpecSnapshot],
    current: &[SpecSnapshot],
) -> Vec<SpecEvent> {
    let mut events = Vec::new();

    let prev_map: HashMap<&str, &SpecSnapshot> =
        previous.iter().map(|s| (s.name.as_str(), s)).collect();
    let curr_map: HashMap<&str, &SpecSnapshot> =
        current.iter().map(|s| (s.name.as_str(), s)).collect();

    // New specs: in current but not in previous.
    for name in curr_map.keys() {
        if !prev_map.contains_key(name) {
            events.push(SpecEvent::NewSpec {
                project: project.to_string(),
                name: name.to_string(),
            });
        }
    }

    // Removed specs: in previous but not in current.
    for name in prev_map.keys() {
        if !curr_map.contains_key(name) {
            events.push(SpecEvent::Removed {
                project: project.to_string(),
                name: name.to_string(),
            });
        }
    }

    // Changed specs: in both, compare task progress.
    for (name, curr) in &curr_map {
        if let Some(prev) = prev_map.get(name) {
            let was_incomplete = prev.completed_tasks < prev.total_tasks || prev.total_tasks == 0;
            let is_all_complete = curr.completed_tasks == curr.total_tasks && curr.total_tasks > 0;

            if is_all_complete && was_incomplete {
                events.push(SpecEvent::AllComplete {
                    project: project.to_string(),
                    name: name.to_string(),
                });
            } else if curr.completed_tasks > prev.completed_tasks {
                events.push(SpecEvent::Progress {
                    project: project.to_string(),
                    name: name.to_string(),
                    completed: curr.completed_tasks,
                    total: curr.total_tasks,
                });
            }
        }
    }

    events
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Background service that polls openspec status across all registered projects.
pub struct SpecWatcherService {
    registry: ProjectRegistry,
    status_cache: ProjectStatusCache,
}

impl SpecWatcherService {
    pub fn new(registry: ProjectRegistry, status_cache: ProjectStatusCache) -> Self {
        Self {
            registry,
            status_cache,
        }
    }

    /// Enumerate projects that have an `openspec/` directory.
    fn enumerate_projects(&self) -> Vec<ProjectPath> {
        self.registry
            .all()
            .into_iter()
            .filter(|p| p.cwd.join("openspec").exists())
            .collect()
    }
}

#[async_trait::async_trait]
impl Service for SpecWatcherService {
    fn name(&self) -> &'static str {
        "spec-watcher"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!(
            "Spec-watcher service starting (interval={}s)",
            POLL_INTERVAL_SECS
        );

        let mut previous_state: HashMap<String, Vec<SpecSnapshot>> = HashMap::new();
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
        // First tick fires immediately — use it to populate initial state.
        let mut first_tick = true;

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Spec-watcher service shutting down");
                    break;
                }
                _ = interval.tick() => {
                    let projects = self.enumerate_projects();
                    if projects.is_empty() {
                        debug!("No projects with openspec/ directory found, skipping poll");
                        continue;
                    }

                    debug!("Polling {} projects for spec status", projects.len());

                    let mut all_events: Vec<SpecEvent> = Vec::new();

                    // Staggered batching: poll BATCH_SIZE projects at a time.
                    for batch in projects.chunks(BATCH_SIZE) {
                        for project in batch {
                            // Poll specs.
                            let specs = poll_project_specs(&project.cwd).await;

                            // Warm the project status cache with a full collection.
                            let status = collect_all(&project.cwd).await;
                            self.status_cache.set(&project.code, status).await;

                            // Detect changes (skip on first tick — just populate state).
                            if !first_tick {
                                let prev = previous_state
                                    .get(&project.code)
                                    .map(|v| v.as_slice())
                                    .unwrap_or(&[]);
                                let events = detect_changes(&project.code, prev, &specs);
                                all_events.extend(events);
                            }

                            // Update state.
                            previous_state.insert(project.code.clone(), specs);
                        }

                        // Inter-batch delay to avoid hammering.
                        tokio::time::sleep(Duration::from_millis(BATCH_DELAY_MS)).await;
                    }

                    if first_tick {
                        info!(
                            "Spec-watcher initial state populated for {} projects",
                            previous_state.len()
                        );
                        first_tick = false;
                        continue;
                    }

                    // Coalesce and send TTS notifications.
                    if !all_events.is_empty() {
                        info!(
                            "Spec-watcher detected {} events across projects",
                            all_events.len()
                        );

                        // Coalesce: wait briefly, then send as a single batched message.
                        tokio::time::sleep(COALESCE_DELAY).await;

                        let messages: Vec<String> =
                            all_events.iter().map(|e| e.to_message()).collect();
                        let combined = messages.join(". ");

                        if let Err(e) = send_notification(&combined, None).await {
                            warn!("Failed to send spec-watcher TTS notification: {}", e);
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(name: &str, status: &str, completed: u32, total: u32) -> SpecSnapshot {
        SpecSnapshot {
            name: name.to_string(),
            status: status.to_string(),
            completed_tasks: completed,
            total_tasks: total,
            last_modified: None,
        }
    }

    #[test]
    fn detect_new_spec() {
        let prev = vec![];
        let curr = vec![snap("add-feature", "active", 0, 5)];
        let events = detect_changes("oo", &prev, &curr);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], SpecEvent::NewSpec { project, name } if project == "oo" && name == "add-feature")
        );
    }

    #[test]
    fn detect_removed_spec() {
        let prev = vec![snap("old-spec", "active", 3, 5)];
        let curr = vec![];
        let events = detect_changes("oo", &prev, &curr);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], SpecEvent::Removed { project, name } if project == "oo" && name == "old-spec")
        );
    }

    #[test]
    fn detect_progress() {
        let prev = vec![snap("feature", "active", 2, 10)];
        let curr = vec![snap("feature", "active", 5, 10)];
        let events = detect_changes("nx", &prev, &curr);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            SpecEvent::Progress {
                completed: 5,
                total: 10,
                ..
            }
        ));
    }

    #[test]
    fn detect_all_complete() {
        let prev = vec![snap("feature", "active", 9, 10)];
        let curr = vec![snap("feature", "active", 10, 10)];
        let events = detect_changes("nx", &prev, &curr);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], SpecEvent::AllComplete { .. }));
    }

    #[test]
    fn no_events_when_unchanged() {
        let prev = vec![snap("feature", "active", 5, 10)];
        let curr = vec![snap("feature", "active", 5, 10)];
        let events = detect_changes("nx", &prev, &curr);
        assert!(events.is_empty());
    }

    #[test]
    fn no_all_complete_when_total_is_zero() {
        let prev = vec![snap("draft", "draft", 0, 0)];
        let curr = vec![snap("draft", "draft", 0, 0)];
        let events = detect_changes("nx", &prev, &curr);
        assert!(events.is_empty());
    }

    #[test]
    fn parse_spec_list_valid() {
        let json = r#"[
            {"name": "add-feature", "status": "active", "completedTasks": 3, "totalTasks": 10},
            {"name": "fix-bug", "status": "draft", "completedTasks": 0, "totalTasks": 5}
        ]"#;
        let specs = parse_spec_list(json);
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].name, "add-feature");
        assert_eq!(specs[0].completed_tasks, 3);
        assert_eq!(specs[0].total_tasks, 10);
        assert_eq!(specs[1].name, "fix-bug");
    }

    #[test]
    fn parse_spec_list_empty() {
        assert!(parse_spec_list("[]").is_empty());
    }

    #[test]
    fn parse_spec_list_invalid_json() {
        assert!(parse_spec_list("not json").is_empty());
    }

    #[test]
    fn parse_spec_list_snake_case_keys() {
        let json = r#"[{"name":"s","status":"active","completed_tasks":2,"total_tasks":8}]"#;
        let specs = parse_spec_list(json);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].completed_tasks, 2);
        assert_eq!(specs[0].total_tasks, 8);
    }
}
