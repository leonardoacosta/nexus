use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use nexus_core::session::Session;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::registry::SessionRegistry;

/// Known candidate paths for sessions.json.
const CANDIDATE_PATHS: &[&str] = &[
    ".claude/scripts/state/sessions.json",
    ".claude/sessions.json",
];

/// Resolve the sessions.json path by checking known locations under $HOME.
fn resolve_sessions_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let home = PathBuf::from(home);

    for candidate in CANDIDATE_PATHS {
        let path = home.join(candidate);
        if path.exists() {
            return Some(path);
        }
    }

    // Default to the primary candidate even if it doesn't exist yet —
    // we'll watch the parent directory and wait for it to appear.
    Some(home.join(CANDIDATE_PATHS[0]))
}

/// Parse sessions.json contents into a Vec<Session>.
fn parse_sessions(contents: &str) -> Result<Vec<Session>> {
    let sessions: Vec<Session> =
        serde_json::from_str(contents).context("failed to parse sessions.json")?;
    Ok(sessions)
}

/// Load and parse sessions from disk, returning an empty vec on any error.
fn load_sessions(path: &PathBuf) -> Vec<Session> {
    match std::fs::read_to_string(path) {
        Ok(contents) => match parse_sessions(&contents) {
            Ok(sessions) => sessions,
            Err(e) => {
                tracing::warn!("failed to parse {}: {}", path.display(), e);
                Vec::new()
            }
        },
        Err(e) => {
            tracing::warn!("failed to read {}: {}", path.display(), e);
            Vec::new()
        }
    }
}

/// Start watching sessions.json for changes and update the registry.
///
/// This function spawns a blocking `notify` watcher on a dedicated thread and
/// bridges events to tokio via an mpsc channel with 100ms debounce.
pub async fn start_session_watcher(registry: Arc<SessionRegistry>) -> Result<()> {
    let sessions_path = resolve_sessions_path()
        .context("could not determine sessions.json path (HOME not set?)")?;

    tracing::info!("watching sessions file: {}", sessions_path.display());

    // Do an initial load so we don't start with an empty registry.
    let initial = load_sessions(&sessions_path);
    if !initial.is_empty() {
        tracing::info!("loaded {} initial sessions", initial.len());
        registry.upsert_sessions(initial).await;
    }

    // Determine the directory to watch. We watch the parent so we can detect
    // file creation (atomic rename) as well as in-place writes.
    let watch_dir = sessions_path
        .parent()
        .context("sessions.json has no parent directory")?
        .to_path_buf();

    let target_filename = sessions_path
        .file_name()
        .context("sessions.json has no filename")?
        .to_os_string();

    // Channel to bridge notify events from the blocking watcher thread into tokio.
    let (tx, mut rx) = mpsc::channel::<()>(16);

    // Spawn the notify watcher on a dedicated thread (notify uses blocking I/O).
    let watch_dir_clone = watch_dir.clone();
    let target_filename_clone = target_filename.clone();
    std::thread::spawn(move || {
        let rt_tx = tx;
        let mut watcher: RecommendedWatcher =
            match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                match res {
                    Ok(event) => {
                        let dominated =
                            matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_));
                        if !dominated {
                            return;
                        }

                        // Only react to events on our target file.
                        let is_target = event.paths.iter().any(|p| {
                            p.file_name()
                                .is_some_and(|name| name == target_filename_clone)
                        });

                        if is_target {
                            let _ = rt_tx.try_send(());
                        }
                    }
                    Err(e) => {
                        tracing::error!("file watcher error: {}", e);
                    }
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("failed to create file watcher: {}", e);
                    return;
                }
            };

        if let Err(e) = watcher.watch(&watch_dir_clone, RecursiveMode::NonRecursive) {
            tracing::error!(
                "failed to start watching {}: {}",
                watch_dir_clone.display(),
                e
            );
            return;
        }

        tracing::debug!("file watcher started on {}", watch_dir_clone.display());

        // Keep the watcher alive — this thread blocks until the process exits.
        std::thread::park();
    });

    // Debounce + reload loop in tokio.
    let sessions_path_clone = sessions_path.clone();
    tokio::spawn(async move {
        loop {
            // Wait for the first notification.
            if rx.recv().await.is_none() {
                tracing::warn!("file watcher channel closed, stopping reload loop");
                break;
            }

            // Debounce: drain any additional events that arrive within 100ms.
            tokio::time::sleep(Duration::from_millis(100)).await;
            while rx.try_recv().is_ok() {}

            // Reload sessions from disk.
            let sessions = load_sessions(&sessions_path_clone);
            tracing::debug!("reloaded {} sessions from file watcher", sessions.len());
            registry.upsert_sessions(sessions).await;
        }
    });

    Ok(())
}
