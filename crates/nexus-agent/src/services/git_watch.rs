//! Git Repository Watch Service
//!
//! Polls git repositories for changes (branch switches, new commits, detached HEAD)
//! and logs events via tracing. Watches all project directories that contain a `.git`
//! directory.
//!
//! Design: polling-based (not inotify/fswatch) for simplicity and cross-platform compat.

use crate::claude_utils::path::expand_home;
use crate::claude_utils::project::get_projects;
use crate::services::Service;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

// --- Types ---

/// Tracked state for a single git repository.
#[derive(Debug, Clone)]
#[allow(dead_code)]
struct RepoState {
    /// Current branch ref (e.g., "refs/heads/main") or "HEAD" for detached
    branch: String,
    /// Current commit SHA
    commit: String,
    /// Last time this repo was successfully polled
    last_checked: Instant,
}

/// Events emitted when repository state changes.
#[derive(Debug)]
enum GitEvent {
    BranchSwitch {
        repo: String,
        old_branch: String,
        new_branch: String,
        commit: String,
    },
    NewCommit {
        repo: String,
        branch: String,
        old_sha: String,
        new_sha: String,
    },
    DetachedHead {
        repo: String,
        commit: String,
    },
}

// --- Core Logic ---

/// Read the current branch ref and commit hash from a `.git` directory.
///
/// Returns `(ref_path, commit_hash)` where:
/// - `ref_path` is e.g. `"refs/heads/main"` for a normal branch
/// - `ref_path` is `"HEAD"` for a detached HEAD
/// - `commit_hash` is the full SHA of the current commit
fn read_git_head(git_dir: &Path) -> Result<(String, String)> {
    let head_path = git_dir.join("HEAD");
    let head_content = std::fs::read_to_string(&head_path)
        .with_context(|| format!("Failed to read {}", head_path.display()))?;
    let head = head_content.trim();

    if let Some(ref_path) = head.strip_prefix("ref: ") {
        // Normal branch: "ref: refs/heads/main"
        let commit = read_ref_commit(git_dir, ref_path)?;
        Ok((ref_path.to_string(), commit))
    } else {
        // Detached HEAD: just a commit hash
        Ok(("HEAD".to_string(), head.to_string()))
    }
}

/// Read the commit hash for a given ref, checking the loose ref file first,
/// then falling back to packed-refs.
fn read_ref_commit(git_dir: &Path, ref_path: &str) -> Result<String> {
    // Try loose ref file first (e.g., .git/refs/heads/main)
    let loose_path = git_dir.join(ref_path);
    if loose_path.exists() {
        let content = std::fs::read_to_string(&loose_path)
            .with_context(|| format!("Failed to read loose ref {}", loose_path.display()))?;
        let commit = content.trim().to_string();
        if !commit.is_empty() {
            return Ok(commit);
        }
    }

    // Fall back to packed-refs
    let packed_refs_path = git_dir.join("packed-refs");
    if packed_refs_path.exists() {
        let content = std::fs::read_to_string(&packed_refs_path)
            .with_context(|| format!("Failed to read {}", packed_refs_path.display()))?;

        for line in content.lines() {
            // Skip comments and peel lines
            if line.starts_with('#') || line.starts_with('^') {
                continue;
            }
            // Format: "<sha> <ref>"
            if let Some((sha, r)) = line.split_once(' ') {
                if r == ref_path {
                    return Ok(sha.to_string());
                }
            }
        }
    }

    // If neither loose ref nor packed-refs has the commit, return empty
    // This can happen briefly during git operations
    Ok(String::new())
}

/// Extract a short display name for a branch ref.
/// "refs/heads/main" -> "main", "HEAD" -> "HEAD"
fn short_branch_name(ref_path: &str) -> &str {
    ref_path.strip_prefix("refs/heads/").unwrap_or(ref_path)
}

/// Discover all project directories that contain a `.git` directory.
fn discover_watch_paths() -> Vec<(String, PathBuf)> {
    let projects = get_projects();
    let mut paths = Vec::new();

    for project in projects {
        let expanded = expand_home(&project.path);
        let git_dir = expanded.join(".git");
        if git_dir.is_dir() {
            paths.push((project.code.clone(), expanded));
        } else {
            debug!(
                "Skipping project '{}': no .git directory at {}",
                project.code,
                expanded.display()
            );
        }
    }

    paths
}

/// Poll all watched repositories and detect changes.
fn poll_repos(
    watch_paths: &[(String, PathBuf)],
    states: &mut HashMap<String, RepoState>,
) -> Vec<GitEvent> {
    let mut events = Vec::new();

    for (code, repo_path) in watch_paths {
        let git_dir = repo_path.join(".git");

        // Skip repos that have disappeared (unmounted, deleted)
        if !git_dir.is_dir() {
            if states.remove(code).is_some() {
                warn!(
                    "Repository '{}' no longer exists at {}, removing from watch",
                    code,
                    repo_path.display()
                );
            }
            continue;
        }

        match read_git_head(&git_dir) {
            Ok((branch, commit)) => {
                if let Some(prev) = states.get(code) {
                    // Compare with previous state
                    if prev.branch != branch {
                        // Branch switch (or transition to/from detached HEAD)
                        if branch == "HEAD" {
                            events.push(GitEvent::DetachedHead {
                                repo: code.clone(),
                                commit: commit.clone(),
                            });
                        } else {
                            events.push(GitEvent::BranchSwitch {
                                repo: code.clone(),
                                old_branch: prev.branch.clone(),
                                new_branch: branch.clone(),
                                commit: commit.clone(),
                            });
                        }
                    } else if prev.commit != commit && !commit.is_empty() {
                        // Same branch, different commit (new commit, pull, rebase)
                        events.push(GitEvent::NewCommit {
                            repo: code.clone(),
                            branch: branch.clone(),
                            old_sha: prev.commit.clone(),
                            new_sha: commit.clone(),
                        });
                    }
                } else {
                    // First time seeing this repo - just record state, no event
                    debug!(
                        "Initial state for '{}': branch={}, commit={}",
                        code,
                        short_branch_name(&branch),
                        &commit.get(..7).unwrap_or(&commit)
                    );
                }

                // Update state
                states.insert(
                    code.clone(),
                    RepoState {
                        branch,
                        commit,
                        last_checked: Instant::now(),
                    },
                );
            }
            Err(e) => {
                debug!("Failed to read git state for '{}': {}", code, e);
            }
        }
    }

    events
}

/// Log a git event via tracing.
fn emit_event(event: &GitEvent) {
    match event {
        GitEvent::BranchSwitch {
            repo,
            old_branch,
            new_branch,
            commit,
        } => {
            info!(
                "[git-watch] {}: branch switch {} -> {} ({})",
                repo,
                short_branch_name(old_branch),
                short_branch_name(new_branch),
                &commit.get(..7).unwrap_or(commit)
            );
        }
        GitEvent::NewCommit {
            repo,
            branch,
            old_sha,
            new_sha,
        } => {
            info!(
                "[git-watch] {}: new commit on {} ({} -> {})",
                repo,
                short_branch_name(branch),
                &old_sha.get(..7).unwrap_or(old_sha),
                &new_sha.get(..7).unwrap_or(new_sha)
            );
        }
        GitEvent::DetachedHead { repo, commit } => {
            info!(
                "[git-watch] {}: detached HEAD at {}",
                repo,
                &commit.get(..7).unwrap_or(commit)
            );
        }
    }
}

// --- Service Implementation ---

/// Git watch daemon service.
///
/// Polls git repositories at a configurable interval to detect branch switches,
/// new commits, and detached HEAD states. Events are logged via tracing.
pub struct GitWatchService {
    /// Polling interval in seconds
    interval_secs: u64,
    /// Whether the service is healthy
    healthy: Arc<AtomicBool>,
}

impl GitWatchService {
    /// Create a new git watch service with the given poll interval.
    pub fn new(interval_secs: u64) -> Self {
        Self {
            interval_secs,
            healthy: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait::async_trait]
impl Service for GitWatchService {
    fn name(&self) -> &'static str {
        "git-watch"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!(
            "Git-watch service starting (interval={}s)",
            self.interval_secs
        );

        let watch_paths = discover_watch_paths();
        info!(
            "Watching {} git repositories: [{}]",
            watch_paths.len(),
            watch_paths
                .iter()
                .map(|(code, _)| code.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );

        if watch_paths.is_empty() {
            warn!("No git repositories found to watch");
        }

        self.healthy.store(true, Ordering::SeqCst);

        let mut states: HashMap<String, RepoState> = HashMap::new();
        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(self.interval_secs));

        // Initial poll to populate state (no events emitted on first run)
        poll_repos(&watch_paths, &mut states);

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Git-watch service shutting down");
                    break;
                }
                _ = interval.tick() => {
                    let events = poll_repos(&watch_paths, &mut states);
                    for event in &events {
                        emit_event(event);
                    }
                }
            }
        }

        self.healthy.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn health_check(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create a minimal .git directory structure for testing.
    fn setup_git_repo(dir: &Path, branch: &str, commit: &str) {
        let git_dir = dir.join(".git");
        let ref_file = git_dir.join("refs").join("heads").join(branch);

        // Create parent directories (handles nested branches like "feature/auth")
        if let Some(parent) = ref_file.parent() {
            fs::create_dir_all(parent).expect("create ref parent dirs");
        }

        // Write HEAD
        let ref_path = format!("refs/heads/{}", branch);
        fs::write(git_dir.join("HEAD"), format!("ref: {}\n", ref_path)).expect("write HEAD");

        // Write ref file
        fs::write(&ref_file, format!("{}\n", commit)).expect("write ref");
    }

    /// Helper: set up a detached HEAD state.
    fn setup_detached_head(dir: &Path, commit: &str) {
        let git_dir = dir.join(".git");
        fs::create_dir_all(&git_dir).expect("create .git");
        fs::write(git_dir.join("HEAD"), format!("{}\n", commit)).expect("write HEAD");
    }

    /// Helper: set up packed-refs with a given ref and commit.
    fn setup_packed_refs(dir: &Path, ref_path: &str, commit: &str) {
        let git_dir = dir.join(".git");
        fs::create_dir_all(&git_dir).expect("create .git");

        let content = format!(
            "# pack-refs with: peeled fully-peeled sorted\n{} {}\n",
            commit, ref_path
        );
        fs::write(git_dir.join("packed-refs"), content).expect("write packed-refs");
    }

    #[test]
    fn test_read_git_head_normal_branch() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit);

        let (branch, sha) = read_git_head(&tmp.path().join(".git")).expect("should read HEAD");
        assert_eq!(branch, "refs/heads/main");
        assert_eq!(sha, commit);
    }

    #[test]
    fn test_read_git_head_feature_branch() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "deadbeef12345678901234567890abcdef123456";
        setup_git_repo(tmp.path(), "feature/auth-rework", commit);

        let (branch, sha) = read_git_head(&tmp.path().join(".git")).expect("should read HEAD");
        assert_eq!(branch, "refs/heads/feature/auth-rework");
        assert_eq!(sha, commit);
    }

    #[test]
    fn test_read_git_head_detached() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "cafe0123456789abcdef0123456789abcdef0123";
        setup_detached_head(tmp.path(), commit);

        let (branch, sha) = read_git_head(&tmp.path().join(".git")).expect("should read HEAD");
        assert_eq!(branch, "HEAD");
        assert_eq!(sha, commit);
    }

    #[test]
    fn test_read_git_head_missing_git_dir() {
        let tmp = TempDir::new().expect("create temp dir");
        let result = read_git_head(&tmp.path().join(".git"));
        assert!(result.is_err());
    }

    #[test]
    fn test_read_ref_commit_from_packed_refs() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "1234567890abcdef1234567890abcdef12345678";
        let ref_path = "refs/heads/main";

        setup_packed_refs(tmp.path(), ref_path, commit);

        // Write HEAD pointing to the ref (but no loose ref file)
        fs::write(
            tmp.path().join(".git").join("HEAD"),
            format!("ref: {}\n", ref_path),
        )
        .expect("write HEAD");

        let (branch, sha) =
            read_git_head(&tmp.path().join(".git")).expect("should read HEAD via packed-refs");
        assert_eq!(branch, ref_path);
        assert_eq!(sha, commit);
    }

    #[test]
    fn test_read_ref_commit_loose_takes_precedence() {
        let tmp = TempDir::new().expect("create temp dir");
        let packed_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let loose_commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let ref_path = "refs/heads/main";

        // Set up packed-refs with old commit
        setup_packed_refs(tmp.path(), ref_path, packed_commit);

        // Set up loose ref with new commit (takes precedence)
        let refs_dir = tmp.path().join(".git").join("refs").join("heads");
        fs::create_dir_all(&refs_dir).expect("create refs/heads");
        fs::write(refs_dir.join("main"), format!("{}\n", loose_commit)).expect("write loose ref");

        // Write HEAD
        fs::write(
            tmp.path().join(".git").join("HEAD"),
            format!("ref: {}\n", ref_path),
        )
        .expect("write HEAD");

        let (_, sha) = read_git_head(&tmp.path().join(".git")).expect("should read HEAD");
        assert_eq!(
            sha, loose_commit,
            "Loose ref should take precedence over packed-refs"
        );
    }

    #[test]
    fn test_short_branch_name() {
        assert_eq!(short_branch_name("refs/heads/main"), "main");
        assert_eq!(short_branch_name("refs/heads/feature/auth"), "feature/auth");
        assert_eq!(short_branch_name("HEAD"), "HEAD");
        assert_eq!(short_branch_name("refs/tags/v1.0"), "refs/tags/v1.0");
    }

    #[test]
    fn test_poll_repos_initial_no_events() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll should record state but emit no events
        let events = poll_repos(&watch_paths, &mut states);
        assert!(events.is_empty(), "First poll should not emit events");
        assert!(
            states.contains_key("test-project"),
            "State should be recorded"
        );
    }

    #[test]
    fn test_poll_repos_branch_switch() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit1 = "abc1234567890def1234567890abcdef12345678";
        let commit2 = "def5678901234567890abcdef1234567890abcdef";
        setup_git_repo(tmp.path(), "main", commit1);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll
        poll_repos(&watch_paths, &mut states);

        // Switch branch
        setup_git_repo(tmp.path(), "develop", commit2);

        // Second poll should detect branch switch
        let events = poll_repos(&watch_paths, &mut states);
        assert_eq!(events.len(), 1);
        match &events[0] {
            GitEvent::BranchSwitch {
                repo,
                old_branch,
                new_branch,
                ..
            } => {
                assert_eq!(repo, "test-project");
                assert_eq!(old_branch, "refs/heads/main");
                assert_eq!(new_branch, "refs/heads/develop");
            }
            other => panic!("Expected BranchSwitch, got {:?}", other),
        }
    }

    #[test]
    fn test_poll_repos_new_commit() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit1 = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit1);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll
        poll_repos(&watch_paths, &mut states);

        // New commit on same branch
        let commit2 = "def5678901234567890abcdef1234567890abcdef";
        let refs_dir = tmp.path().join(".git").join("refs").join("heads");
        fs::write(refs_dir.join("main"), format!("{}\n", commit2)).expect("write new commit");

        // Second poll should detect new commit
        let events = poll_repos(&watch_paths, &mut states);
        assert_eq!(events.len(), 1);
        match &events[0] {
            GitEvent::NewCommit {
                repo,
                branch,
                old_sha,
                new_sha,
            } => {
                assert_eq!(repo, "test-project");
                assert_eq!(branch, "refs/heads/main");
                assert_eq!(old_sha, commit1);
                assert_eq!(new_sha, commit2);
            }
            other => panic!("Expected NewCommit, got {:?}", other),
        }
    }

    #[test]
    fn test_poll_repos_detached_head() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit1 = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit1);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll
        poll_repos(&watch_paths, &mut states);

        // Detach HEAD
        let commit2 = "cafe0123456789abcdef0123456789abcdef0123";
        setup_detached_head(tmp.path(), commit2);

        // Second poll should detect detached HEAD
        let events = poll_repos(&watch_paths, &mut states);
        assert_eq!(events.len(), 1);
        match &events[0] {
            GitEvent::DetachedHead { repo, commit } => {
                assert_eq!(repo, "test-project");
                assert_eq!(commit, commit2);
            }
            other => panic!("Expected DetachedHead, got {:?}", other),
        }
    }

    #[test]
    fn test_poll_repos_no_change() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll
        poll_repos(&watch_paths, &mut states);

        // Second poll without changes
        let events = poll_repos(&watch_paths, &mut states);
        assert!(events.is_empty(), "No changes should produce no events");
    }

    #[test]
    fn test_poll_repos_missing_repo_removed_from_state() {
        let tmp = TempDir::new().expect("create temp dir");
        let commit = "abc1234567890def1234567890abcdef12345678";
        setup_git_repo(tmp.path(), "main", commit);

        let watch_paths = vec![("test-project".to_string(), tmp.path().to_path_buf())];
        let mut states = HashMap::new();

        // First poll
        poll_repos(&watch_paths, &mut states);
        assert!(states.contains_key("test-project"));

        // Remove .git directory
        fs::remove_dir_all(tmp.path().join(".git")).expect("remove .git");

        // Poll should remove from state
        let events = poll_repos(&watch_paths, &mut states);
        assert!(events.is_empty());
        assert!(!states.contains_key("test-project"));
    }

    #[test]
    fn test_git_watch_service_new() {
        let service = GitWatchService::new(5);
        assert_eq!(service.interval_secs, 5);
        assert_eq!(service.name(), "git-watch");
    }

    #[tokio::test]
    async fn test_git_watch_service_health_check_before_start() {
        let service = GitWatchService::new(5);
        assert!(!service.health_check().await);
    }

    #[tokio::test]
    async fn test_git_watch_service_shutdown() {
        let service = GitWatchService::new(3600); // Long interval so it won't tick
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move { service.start(shutdown_rx).await });

        // Give the service time to start
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Send shutdown
        let _ = shutdown_tx.send(()).await;

        // Should complete without error
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;

        assert!(result.is_ok(), "Service should shut down within timeout");
    }
}
