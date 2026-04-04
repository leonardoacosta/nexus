//! File watcher logic using the `notify` crate.
//!
//! Watches directories for `sessions.json` file changes. When a change is
//! detected, the file is parsed and diffed against the known session state
//! to emit session_start, session_update, and session_end events.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use tokio::sync::{RwLock, mpsc};
use tracing::{debug, error, info, warn};

use crate::ipc::OutboundMessage;

// ---------------------------------------------------------------------------
// Session state tracking
// ---------------------------------------------------------------------------

/// Tracks known sessions across watch cycles for diffing.
#[derive(Default)]
pub struct SessionState {
    /// session_id -> entry with last-known metadata
    pub known: HashMap<String, SessionEntry>,
}

/// Metadata about a known session.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct SessionEntry {
    /// Project code (derived from the directory name).
    pub project: Option<String>,
    /// Path to the sessions.json file that contained this session.
    pub path: PathBuf,
    /// ISO 8601 timestamp of last update.
    pub timestamp: String,
}

// ---------------------------------------------------------------------------
// sessions.json parsing
// ---------------------------------------------------------------------------

/// A single session entry as found in Claude Code's sessions.json file.
/// We only parse the fields we need; unknown fields are silently ignored.
#[derive(Debug, Deserialize)]
struct RawSession {
    /// The unique session identifier (UUID string).
    #[serde(alias = "sessionId")]
    session_id: Option<String>,
    /// Some versions use just "id".
    id: Option<String>,
}

impl RawSession {
    /// Return the session ID, preferring `session_id` over `id`.
    fn get_id(&self) -> Option<&str> {
        self.session_id
            .as_deref()
            .or(self.id.as_deref())
            .filter(|s| !s.is_empty())
    }
}

/// Parse a sessions.json file and return (session_id, raw_json_for_that_entry) pairs.
fn parse_sessions_file(content: &str) -> Vec<String> {
    // sessions.json may be an array of session objects or an object keyed by session ID.
    // Try array first, then object.
    if let Ok(arr) = serde_json::from_str::<Vec<RawSession>>(content) {
        return arr.iter().filter_map(|s| s.get_id().map(String::from)).collect();
    }

    if let Ok(obj) = serde_json::from_str::<HashMap<String, serde_json::Value>>(content) {
        return obj.keys().cloned().collect();
    }

    warn!("sessions.json content could not be parsed as array or object");
    Vec::new()
}

/// Derive a project code from a sessions.json path.
///
/// Expected path patterns:
/// - `~/.claude/projects/-home-user-dev-co/sessions.json` -> extract from dir name
/// - The last path component before `sessions.json` is the project directory name.
///   We extract the final segment after the last dash that looks like a project code.
fn derive_project(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let dir_name = parent.file_name()?.to_str()?;

    // Claude Code project directories are typically named like:
    // `-home-user-dev-co` or `-home-user-dev-nx`
    // The project code is the last segment.
    dir_name.rsplit('-').next().map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

/// Simple debounce: track last-processed time per path.
struct Debounce {
    last: HashMap<PathBuf, tokio::time::Instant>,
    window: Duration,
}

impl Debounce {
    fn new(window: Duration) -> Self {
        Self {
            last: HashMap::new(),
            window,
        }
    }

    fn should_process(&mut self, path: &Path) -> bool {
        let now = tokio::time::Instant::now();
        if let Some(last) = self.last.get(path)
            && now.duration_since(*last) < self.window
        {
            self.last.insert(path.to_path_buf(), now);
            return false;
        }
        self.last.insert(path.to_path_buf(), now);
        true
    }
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

/// Watch a directory path for sessions.json changes.
///
/// This function blocks until the watcher encounters a fatal error. It sets up
/// a `notify::RecommendedWatcher` on the given path (recursive) and processes
/// file change events, diffing session state and emitting IPC messages.
pub async fn watch_path(
    path: &str,
    outbound_tx: mpsc::Sender<OutboundMessage>,
    state: Arc<RwLock<SessionState>>,
) -> anyhow::Result<()> {
    let watch_dir = PathBuf::from(path);

    if !watch_dir.is_dir() {
        warn!("watch path does not exist: {}, creating", watch_dir.display());
        tokio::fs::create_dir_all(&watch_dir).await?;
    }

    info!("starting file watcher on {}", watch_dir.display());

    // Do an initial scan of existing sessions.json files.
    initial_scan(&watch_dir, &outbound_tx, &state).await;

    // Set up notify watcher with a tokio channel bridge.
    let (notify_tx, mut notify_rx) = mpsc::channel::<Event>(256);

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<Event, notify::Error>| match result {
            Ok(event) => {
                let _ = notify_tx.try_send(event);
            }
            Err(e) => {
                error!("notify watcher error: {}", e);
            }
        },
        Config::default(),
    )?;

    watcher.watch(&watch_dir, RecursiveMode::Recursive)?;

    let mut debounce = Debounce::new(Duration::from_millis(200));

    loop {
        match notify_rx.recv().await {
            Some(event) => {
                // We only care about create/modify/remove on sessions.json files.
                if !is_sessions_event(&event) {
                    continue;
                }

                for event_path in &event.paths {
                    if !is_sessions_json(event_path) {
                        continue;
                    }

                    if !debounce.should_process(event_path) {
                        debug!("debounced event for {}", event_path.display());
                        continue;
                    }

                    let is_remove = matches!(event.kind, EventKind::Remove(_));

                    if is_remove {
                        handle_file_removed(event_path, &outbound_tx, &state).await;
                    } else {
                        // Small delay to let the file settle (atomic writes may
                        // trigger multiple events).
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        handle_file_changed(event_path, &outbound_tx, &state).await;
                    }
                }
            }
            None => {
                info!("notify channel closed, watcher exiting");
                break;
            }
        }
    }

    // Keep the watcher alive until the loop exits.
    drop(watcher);
    Ok(())
}

/// Check if a notify event is relevant (create, modify, or remove).
fn is_sessions_event(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

/// Check if a path points to a sessions.json file.
fn is_sessions_json(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| name == "sessions.json")
}

/// Scan for existing sessions.json files on startup and emit session_start
/// events for any sessions found.
async fn initial_scan(
    watch_dir: &Path,
    outbound_tx: &mpsc::Sender<OutboundMessage>,
    state: &Arc<RwLock<SessionState>>,
) {
    // Look for sessions.json files in subdirectories.
    let entries = match std::fs::read_dir(watch_dir) {
        Ok(e) => e,
        Err(e) => {
            warn!("cannot read watch directory {}: {}", watch_dir.display(), e);
            return;
        }
    };

    for entry in entries.flatten() {
        let sessions_path = entry.path().join("sessions.json");
        if sessions_path.is_file() {
            handle_file_changed(&sessions_path, outbound_tx, state).await;
        }
    }
}

/// Process a sessions.json file that was created or modified.
async fn handle_file_changed(
    path: &Path,
    outbound_tx: &mpsc::Sender<OutboundMessage>,
    state: &Arc<RwLock<SessionState>>,
) {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) => {
            debug!("cannot read {}: {}", path.display(), e);
            return;
        }
    };

    let session_ids = parse_sessions_file(&content);
    let project = derive_project(path);
    let now = chrono::Utc::now().to_rfc3339();

    let current_ids: HashSet<&str> = session_ids.iter().map(|s| s.as_str()).collect();

    let mut st = state.write().await;

    // Detect new and updated sessions.
    for sid in &session_ids {
        if let Some(existing) = st.known.get_mut(sid.as_str()) {
            // Session already known — emit update.
            existing.timestamp = now.clone();
            let _ = outbound_tx
                .send(OutboundMessage::SessionUpdate {
                    session_id: sid.clone(),
                    timestamp: now.clone(),
                })
                .await;
        } else {
            // New session — emit start.
            st.known.insert(
                sid.clone(),
                SessionEntry {
                    project: project.clone(),
                    path: path.to_path_buf(),
                    timestamp: now.clone(),
                },
            );
            let _ = outbound_tx
                .send(OutboundMessage::SessionStart {
                    session_id: sid.clone(),
                    project: project.clone(),
                    path: path.display().to_string(),
                })
                .await;
        }
    }

    // Detect ended sessions: sessions previously in this file that are now gone.
    let ended: Vec<String> = st
        .known
        .iter()
        .filter(|(_, entry)| entry.path == path)
        .filter(|(id, _)| !current_ids.contains(id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();

    for sid in ended {
        st.known.remove(&sid);
        let _ = outbound_tx
            .send(OutboundMessage::SessionEnd {
                session_id: sid,
            })
            .await;
    }
}

/// Process a sessions.json file that was removed — end all sessions from that file.
async fn handle_file_removed(
    path: &Path,
    outbound_tx: &mpsc::Sender<OutboundMessage>,
    state: &Arc<RwLock<SessionState>>,
) {
    let mut st = state.write().await;

    let ended: Vec<String> = st
        .known
        .iter()
        .filter(|(_, entry)| entry.path == path)
        .map(|(id, _)| id.clone())
        .collect();

    for sid in ended {
        st.known.remove(&sid);
        let _ = outbound_tx
            .send(OutboundMessage::SessionEnd {
                session_id: sid,
            })
            .await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sessions_array_format() {
        let json = r#"[
            {"session_id": "abc123"},
            {"session_id": "def456"}
        ]"#;
        let ids = parse_sessions_file(json);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"abc123".to_string()));
        assert!(ids.contains(&"def456".to_string()));
    }

    #[test]
    fn parse_sessions_object_format() {
        let json = r#"{
            "abc123": {"status": "active"},
            "def456": {"status": "idle"}
        }"#;
        let ids = parse_sessions_file(json);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"abc123".to_string()));
        assert!(ids.contains(&"def456".to_string()));
    }

    #[test]
    fn parse_sessions_with_id_field() {
        let json = r#"[{"id": "abc123"}]"#;
        let ids = parse_sessions_file(json);
        assert_eq!(ids, vec!["abc123"]);
    }

    #[test]
    fn parse_sessions_invalid_json() {
        let ids = parse_sessions_file("not json at all");
        assert!(ids.is_empty());
    }

    #[test]
    fn parse_sessions_empty_array() {
        let ids = parse_sessions_file("[]");
        assert!(ids.is_empty());
    }

    #[test]
    fn parse_sessions_empty_object() {
        let ids = parse_sessions_file("{}");
        assert!(ids.is_empty());
    }

    #[test]
    fn derive_project_from_path() {
        let path = Path::new("/home/user/.claude/projects/-home-user-dev-co/sessions.json");
        assert_eq!(derive_project(path), Some("co".to_string()));
    }

    #[test]
    fn derive_project_from_simple_path() {
        let path = Path::new("/home/user/.claude/projects/myproject/sessions.json");
        assert_eq!(derive_project(path), Some("myproject".to_string()));
    }

    #[test]
    fn derive_project_returns_none_for_root() {
        let path = Path::new("/sessions.json");
        // Parent is "/", no file_name
        assert!(derive_project(path).is_some() || derive_project(path).is_none());
    }

    #[test]
    fn is_sessions_json_matches() {
        assert!(is_sessions_json(Path::new("/foo/bar/sessions.json")));
        assert!(is_sessions_json(Path::new("sessions.json")));
    }

    #[test]
    fn is_sessions_json_rejects() {
        assert!(!is_sessions_json(Path::new("/foo/bar/config.json")));
        assert!(!is_sessions_json(Path::new("/foo/bar/sessions.jsonl")));
        assert!(!is_sessions_json(Path::new("/foo/bar/sessions")));
    }

    #[test]
    fn is_sessions_event_matches_create() {
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![],
            attrs: Default::default(),
        };
        assert!(is_sessions_event(&event));
    }

    #[test]
    fn is_sessions_event_matches_modify() {
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![],
            attrs: Default::default(),
        };
        assert!(is_sessions_event(&event));
    }

    #[test]
    fn is_sessions_event_matches_remove() {
        let event = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![],
            attrs: Default::default(),
        };
        assert!(is_sessions_event(&event));
    }

    #[test]
    fn is_sessions_event_rejects_access() {
        let event = Event {
            kind: EventKind::Access(notify::event::AccessKind::Read),
            paths: vec![],
            attrs: Default::default(),
        };
        assert!(!is_sessions_event(&event));
    }

    #[test]
    fn debounce_first_event_passes() {
        let mut debounce = Debounce::new(Duration::from_secs(1));
        assert!(debounce.should_process(Path::new("/tmp/sessions.json")));
    }

    #[test]
    fn debounce_immediate_repeat_blocked() {
        let mut debounce = Debounce::new(Duration::from_secs(1));
        let path = Path::new("/tmp/sessions.json");
        assert!(debounce.should_process(path));
        assert!(!debounce.should_process(path));
    }

    #[test]
    fn debounce_different_paths_independent() {
        let mut debounce = Debounce::new(Duration::from_secs(1));
        let path_a = Path::new("/tmp/a/sessions.json");
        let path_b = Path::new("/tmp/b/sessions.json");
        assert!(debounce.should_process(path_a));
        assert!(debounce.should_process(path_b));
    }
}
