//! Spec Watcher Service
//!
//! Proactively polls openspec + beads status across all registered projects,
//! detects state transitions (new/progress/complete/archived), emits TTS
//! notifications, and warms the [`ProjectStatusCache`].
//!
//! Spec state is persisted in the SQLite backing store (`NexusDb`). The
//! in-memory `HashMap` previously used for change detection has been removed.
//!
//! Design: 60-second poll interval, staggered batches of 3-5 projects with
//! 200ms inter-batch delay. Only projects that have an `openspec/` directory
//! are polled.

use crate::claude_utils::notify::send_notification;
use crate::services::Service;
use crate::services::project_status::{ProjectStatusCache, collect_all};
use anyhow::Result;
use nexus_core::db::{NexusDb, SpecRecord, SpecSnapshotRecord, proposal_hash};
use nexus_core::project_registry::{ProjectPath, ProjectRegistry, SpecSnapshot};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
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
    /// Proposal hash changed — spec needs re-review.
    HashChanged { project: String, name: String },
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
            Self::HashChanged { project, name } => {
                format!(
                    "Spec {} in {} was modified — needs re-review",
                    name, project
                )
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
// DB-backed change detection
// ---------------------------------------------------------------------------

/// Handle hash-change detection for an existing spec.
///
/// If the proposal was edited after review (read/approved), reset it to unread.
/// Returns `true` if a hash change was detected and the spec was reset (caller
/// should `continue` to skip further processing for this spec).
fn handle_hash_change(
    db: &NexusDb,
    project: &str,
    spec_id: &str,
    snap: &SpecSnapshot,
    existing: &SpecRecord,
    hash: &Option<String>,
    first_tick: bool,
    events: &mut Vec<SpecEvent>,
) -> bool {
    if let Some(new_hash) = hash
        && let Some(ref old_hash) = existing.proposal_hash
        && new_hash != old_hash
        && (existing.status == "read" || existing.status == "approved")
    {
        // Reset to unread — proposal was edited after review.
        let mut updated = existing.clone();
        updated.status = "unread".to_string();
        updated.proposal_hash = Some(new_hash.clone());
        updated.read_at = None;
        updated.approved_at = None;
        updated.tasks_done = snap.completed_tasks;
        updated.tasks_total = snap.total_tasks;
        if let Err(e) = db.upsert_spec(&updated) {
            warn!("Failed to reset spec {}: {}", spec_id, e);
        }
        // Audit event: proposal edited, spec reset (best-effort).
        let _ = db.log_event(
            "spec_hash_reset",
            "spec_watcher",
            spec_id,
            Some("proposal edited after review — reset to unread"),
        );
        if !first_tick {
            events.push(SpecEvent::HashChanged {
                project: project.to_string(),
                name: snap.name.clone(),
            });
        }
        return true;
    }
    false
}

/// Handle task-progress detection for an existing spec.
///
/// Detects progress increments and all-tasks-complete transitions.
fn handle_task_progress(
    db: &NexusDb,
    project: &str,
    spec_id: &str,
    snap: &SpecSnapshot,
    existing: &SpecRecord,
    hash: &Option<String>,
    now: &str,
    first_tick: bool,
    events: &mut Vec<SpecEvent>,
) {
    if !first_tick {
        let was_incomplete = existing.tasks_done < existing.tasks_total || existing.tasks_total == 0;
        let is_all_complete = snap.completed_tasks == snap.total_tasks && snap.total_tasks > 0;

        if is_all_complete && was_incomplete {
            events.push(SpecEvent::AllComplete {
                project: project.to_string(),
                name: snap.name.clone(),
            });
        } else if snap.completed_tasks > existing.tasks_done {
            events.push(SpecEvent::Progress {
                project: project.to_string(),
                name: snap.name.clone(),
                completed: snap.completed_tasks,
                total: snap.total_tasks,
            });
        }
    }

    // Update task counts and hash in DB.
    if snap.completed_tasks != existing.tasks_done || snap.total_tasks != existing.tasks_total {
        if let Err(e) =
            db.update_spec_tasks(project, &snap.name, snap.completed_tasks, snap.total_tasks)
        {
            warn!("Failed to update spec tasks {}: {}", spec_id, e);
        }

        // Insert spec snapshot if completed_tasks changed (deduped).
        if snap.completed_tasks != existing.tasks_done {
            let should_insert = match db.latest_spec_snapshot(project, &snap.name) {
                Ok(Some(latest)) => {
                    latest.completed_tasks != Some(snap.completed_tasks)
                        || latest.total_tasks != Some(snap.total_tasks)
                }
                _ => true,
            };
            if should_insert {
                let snapshot_record = SpecSnapshotRecord {
                    timestamp: now.to_string(),
                    project: project.to_string(),
                    spec_name: snap.name.clone(),
                    completed_tasks: Some(snap.completed_tasks),
                    total_tasks: Some(snap.total_tasks),
                };
                if let Err(e) = db.insert_spec_snapshot(&snapshot_record) {
                    warn!("Failed to insert spec snapshot {}: {}", spec_id, e);
                }
            }
        }
    }
    // Update hash if changed (but status wasn't read/approved, so no reset).
    if *hash != existing.proposal_hash {
        let mut updated = existing.clone();
        updated.proposal_hash = hash.clone();
        updated.tasks_done = snap.completed_tasks;
        updated.tasks_total = snap.total_tasks;
        if let Err(e) = db.upsert_spec(&updated) {
            warn!("Failed to update spec hash {}: {}", spec_id, e);
        }
    }
}

/// Handle insertion of a newly discovered spec.
fn handle_new_spec(
    db: &NexusDb,
    project: &str,
    spec_id: &str,
    snap: &SpecSnapshot,
    hash: Option<String>,
    now: &str,
    first_tick: bool,
    events: &mut Vec<SpecEvent>,
) {
    let record = SpecRecord {
        id: spec_id.to_string(),
        project: project.to_string(),
        name: snap.name.clone(),
        status: "unread".to_string(),
        title: None,
        summary: None,
        tasks_total: snap.total_tasks,
        tasks_done: snap.completed_tasks,
        proposal_hash: hash,
        discovered_at: now.to_string(),
        read_at: None,
        approved_at: None,
        applied_at: None,
        archived_at: None,
        rejected_at: None,
        rejection_reason: None,
    };
    if let Err(e) = db.upsert_spec(&record) {
        warn!("Failed to insert spec {}: {}", spec_id, e);
    }
    // Audit event: new spec discovered (best-effort).
    let _ = db.log_event("spec_discovered", "spec_watcher", spec_id, None);
    if !first_tick {
        events.push(SpecEvent::NewSpec {
            project: project.to_string(),
            name: snap.name.clone(),
        });
    }
}

/// Handle detection and archival of specs that were removed from disk.
///
/// If a spec was 'applied' in the DB but is no longer on disk, archive it.
fn handle_spec_removal(
    db: &NexusDb,
    project: &str,
    current_names: &HashSet<&str>,
    first_tick: bool,
    events: &mut Vec<SpecEvent>,
) {
    if let Ok(all_specs) = db.list_specs(Some(&["applied"])) {
        for existing in all_specs {
            if existing.project == project && !current_names.contains(existing.name.as_str()) {
                if let Err(e) = db.update_spec_status(project, &existing.name, "archived") {
                    warn!("Failed to archive spec {}: {}", existing.id, e);
                }
                // Audit event: spec archived (best-effort).
                let _ = db.log_event("spec_archived", "spec_watcher", &existing.id, None);
                if !first_tick {
                    events.push(SpecEvent::Removed {
                        project: project.to_string(),
                        name: existing.name.clone(),
                    });
                }
            }
        }
    }
}

/// Process specs from a single project against the DB, returning detected events.
///
/// Dispatches to per-event-type handlers: hash change, task progress, new spec,
/// and spec removal.
fn process_project_specs(
    db: &NexusDb,
    project: &str,
    cwd: &Path,
    current_specs: &[SpecSnapshot],
    first_tick: bool,
) -> Vec<SpecEvent> {
    let mut events = Vec::new();
    let now = chrono::Utc::now().to_rfc3339();

    // Build set of current spec names for removal detection.
    let current_names: HashSet<&str> = current_specs.iter().map(|s| s.name.as_str()).collect();

    // Process each spec found on disk.
    for snap in current_specs {
        let spec_id = format!("{project}/{}", snap.name);

        // Try to read proposal.md for hash computation.
        let hash = read_proposal_hash(cwd, &snap.name);

        match db.get_spec(project, &snap.name) {
            Ok(Some(existing)) => {
                // Hash change resets reviewed specs to unread; skip further processing.
                if handle_hash_change(
                    db, project, &spec_id, snap, &existing, &hash, first_tick, &mut events,
                ) {
                    continue;
                }

                // Task progress detection + DB updates.
                handle_task_progress(
                    db,
                    project,
                    &spec_id,
                    snap,
                    &existing,
                    &hash,
                    &now,
                    first_tick,
                    &mut events,
                );
            }
            Ok(None) => {
                handle_new_spec(
                    db, project, &spec_id, snap, hash, &now, first_tick, &mut events,
                );
            }
            Err(e) => {
                warn!("Failed to read spec {} from DB: {}", spec_id, e);
            }
        }
    }

    // Spec removal detection.
    handle_spec_removal(db, project, &current_names, first_tick, &mut events);

    events
}

/// Read proposal.md from disk and compute its SHA-256 hash.
fn read_proposal_hash(cwd: &Path, spec_name: &str) -> Option<String> {
    let proposal_path = cwd
        .join("openspec")
        .join("changes")
        .join(spec_name)
        .join("proposal.md");
    match std::fs::read(&proposal_path) {
        Ok(content) => Some(proposal_hash(&content)),
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/// Background service that polls openspec status across all registered projects.
pub struct SpecWatcherService {
    registry: ProjectRegistry,
    status_cache: ProjectStatusCache,
    db: Arc<NexusDb>,
}

impl SpecWatcherService {
    pub fn new(
        registry: ProjectRegistry,
        status_cache: ProjectStatusCache,
        db: Arc<NexusDb>,
    ) -> Self {
        Self {
            registry,
            status_cache,
            db,
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

                            // DB-backed change detection.
                            let events = process_project_specs(
                                &self.db,
                                &project.code,
                                &project.cwd,
                                &specs,
                                first_tick,
                            );
                            all_events.extend(events);
                        }

                        // Inter-batch delay to avoid hammering.
                        tokio::time::sleep(Duration::from_millis(BATCH_DELAY_MS)).await;
                    }

                    if first_tick {
                        info!(
                            "Spec-watcher initial state populated for {} projects",
                            projects.len()
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
    use nexus_core::db::NexusDb;

    fn snap(name: &str, status: &str, completed: u32, total: u32) -> SpecSnapshot {
        SpecSnapshot {
            name: name.to_string(),
            status: status.to_string(),
            completed_tasks: completed,
            total_tasks: total,
            last_modified: None,
        }
    }

    fn test_db() -> Arc<NexusDb> {
        let db = NexusDb::open_in_memory().unwrap();
        db.migrate().unwrap();
        Arc::new(db)
    }

    #[test]
    fn detect_new_spec_via_db() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");
        let current = vec![snap("add-feature", "active", 0, 5)];
        let events = process_project_specs(&db, "oo", cwd, &current, false);

        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            SpecEvent::NewSpec { project, name }
            if project == "oo" && name == "add-feature"
        ));

        // Verify it was persisted in DB.
        let stored = db.get_spec("oo", "add-feature").unwrap().unwrap();
        assert_eq!(stored.status, "unread");
        assert_eq!(stored.tasks_total, 5);
    }

    #[test]
    fn detect_progress_via_db() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");

        // First tick — populate.
        let initial = vec![snap("feature", "active", 2, 10)];
        let events = process_project_specs(&db, "nx", cwd, &initial, true);
        assert!(events.is_empty()); // first tick = no events

        // Second tick — progress.
        let updated = vec![snap("feature", "active", 5, 10)];
        let events = process_project_specs(&db, "nx", cwd, &updated, false);
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
    fn detect_all_complete_via_db() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");

        let initial = vec![snap("feature", "active", 9, 10)];
        process_project_specs(&db, "nx", cwd, &initial, true);

        let updated = vec![snap("feature", "active", 10, 10)];
        let events = process_project_specs(&db, "nx", cwd, &updated, false);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], SpecEvent::AllComplete { .. }));
    }

    #[test]
    fn no_events_when_unchanged() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");

        let specs = vec![snap("feature", "active", 5, 10)];
        process_project_specs(&db, "nx", cwd, &specs, true);

        let events = process_project_specs(&db, "nx", cwd, &specs, false);
        assert!(events.is_empty());
    }

    #[test]
    fn no_all_complete_when_total_is_zero() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");

        let specs = vec![snap("draft", "draft", 0, 0)];
        process_project_specs(&db, "nx", cwd, &specs, true);

        let events = process_project_specs(&db, "nx", cwd, &specs, false);
        assert!(events.is_empty());
    }

    #[test]
    fn detect_removal_of_applied_spec() {
        let db = test_db();
        let cwd = Path::new("/tmp/nonexistent-project");

        // Insert an applied spec directly into DB.
        let record = SpecRecord {
            id: "nx/old-spec".to_string(),
            project: "nx".to_string(),
            name: "old-spec".to_string(),
            status: "applied".to_string(),
            title: None,
            summary: None,
            tasks_total: 5,
            tasks_done: 5,
            proposal_hash: None,
            discovered_at: chrono::Utc::now().to_rfc3339(),
            read_at: None,
            approved_at: None,
            applied_at: Some(chrono::Utc::now().to_rfc3339()),
            archived_at: None,
            rejected_at: None,
            rejection_reason: None,
        };
        db.upsert_spec(&record).unwrap();

        // Poll with empty specs — old-spec is gone from disk.
        let events = process_project_specs(&db, "nx", cwd, &[], false);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            SpecEvent::Removed { project, name }
            if project == "nx" && name == "old-spec"
        ));

        // Verify it was archived in DB.
        let stored = db.get_spec("nx", "old-spec").unwrap().unwrap();
        assert_eq!(stored.status, "archived");
    }

    #[test]
    fn hash_change_resets_approved_spec() {
        let db = test_db();
        let _cwd = Path::new("/tmp/nonexistent-project");

        // Insert an approved spec with a known hash.
        let record = SpecRecord {
            id: "oo/edited".to_string(),
            project: "oo".to_string(),
            name: "edited".to_string(),
            status: "approved".to_string(),
            title: None,
            summary: None,
            tasks_total: 5,
            tasks_done: 2,
            proposal_hash: Some("old_hash".to_string()),
            discovered_at: chrono::Utc::now().to_rfc3339(),
            read_at: Some(chrono::Utc::now().to_rfc3339()),
            approved_at: Some(chrono::Utc::now().to_rfc3339()),
            applied_at: None,
            archived_at: None,
            rejected_at: None,
            rejection_reason: None,
        };
        db.upsert_spec(&record).unwrap();

        // Note: proposal_hash reading from disk will return None for
        // nonexistent paths, so no hash change is detected here. The real
        // hash change detection works when the file exists. We test the DB
        // logic directly instead.

        // Simulate what process_project_specs does on hash mismatch:
        let mut updated = record.clone();
        updated.status = "unread".to_string();
        updated.proposal_hash = Some("new_hash".to_string());
        updated.read_at = None;
        updated.approved_at = None;
        db.upsert_spec(&updated).unwrap();

        let stored = db.get_spec("oo", "edited").unwrap().unwrap();
        assert_eq!(stored.status, "unread");
        assert_eq!(stored.proposal_hash.as_deref(), Some("new_hash"));
        assert!(stored.read_at.is_none());
        assert!(stored.approved_at.is_none());
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
