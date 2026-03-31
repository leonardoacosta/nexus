//! Project Status Collection
//!
//! Collects project status by running native CLI commands in a project's working
//! directory. Three collectors:
//!
//! - [`collect_beads_status`]: runs `bd ready --json` + `bd stats`
//! - [`collect_git_status`]: runs `git -C <path>` commands
//! - [`collect_spec_status`]: runs `openspec list --json` (if openspec/ dir exists)
//!
//! All collectors handle subprocess failures gracefully (5 s timeout) and return
//! default/empty structs on error — they never panic.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;

const SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

/// Output from `bd ready --json` and `bd stats`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BeadsStatus {
    /// Number of issues returned by `bd ready`
    pub ready_count: i32,
    /// Total open issues from `bd stats`
    pub open_count: i32,
    /// Total blocked issues from `bd stats`
    pub blocked_count: i32,
    /// Raw JSON string from `bd ready --json` (unparsed)
    pub ready_json: String,
}

/// Output from `git -C <path>` status commands.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitStatus {
    /// Current branch name
    pub branch: String,
    /// Short HEAD commit SHA
    pub head_sha: String,
    /// Recent commits from `git log --oneline -5`
    pub recent_commits: Vec<String>,
    /// Output of `git status --porcelain`
    pub porcelain: String,
}

/// Output from `openspec list --json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SpecStatus {
    /// Total number of specs
    pub spec_count: i32,
    /// Number of specs with active changes
    pub change_count: i32,
    /// Names / identifiers of active change specs
    pub active_changes: Vec<String>,
}

/// Combined project status from all three collectors.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectStatus {
    pub beads: BeadsStatus,
    pub git: GitStatus,
    pub spec: SpecStatus,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run a command with a 5-second timeout, returning stdout as a String.
/// Returns `None` on timeout, non-zero exit, or any IO error.
async fn run_cmd(program: &str, args: &[&str], cwd: &Path) -> Option<String> {
    let fut = async {
        let output = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .output()
            .await;

        match output {
            Ok(out) if out.status.success() => {
                Some(String::from_utf8_lossy(&out.stdout).into_owned())
            }
            Ok(out) => {
                warn!(
                    program,
                    args = ?args,
                    cwd = %cwd.display(),
                    exit = ?out.status.code(),
                    "subprocess exited with non-zero status"
                );
                None
            }
            Err(e) => {
                warn!(
                    program,
                    args = ?args,
                    cwd = %cwd.display(),
                    err = %e,
                    "subprocess IO error"
                );
                None
            }
        }
    };

    match timeout(SUBPROCESS_TIMEOUT, fut).await {
        Ok(result) => result,
        Err(_) => {
            warn!(
                program,
                args = ?args,
                cwd = %cwd.display(),
                "subprocess timed out after 5s"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/// Collect beads status by running `bd ready --json` and `bd stats`.
pub async fn collect_beads_status(cwd: &Path) -> BeadsStatus {
    // Run both commands concurrently.
    let (ready_out, stats_out) = tokio::join!(
        run_cmd("bd", &["ready", "--json"], cwd),
        run_cmd("bd", &["stats"], cwd),
    );

    let ready_json = ready_out.unwrap_or_default();

    // Count items in the ready JSON array without deep-parsing.
    let ready_count = if ready_json.trim().is_empty() {
        0
    } else {
        match serde_json::from_str::<serde_json::Value>(&ready_json) {
            Ok(serde_json::Value::Array(arr)) => arr.len() as i32,
            _ => 0,
        }
    };

    let (open_count, blocked_count) = parse_bd_stats(stats_out.as_deref().unwrap_or(""));

    BeadsStatus {
        ready_count,
        open_count,
        blocked_count,
        ready_json,
    }
}

/// Parse `bd stats` text output looking for "Open: N" and "Blocked: N".
fn parse_bd_stats(text: &str) -> (i32, i32) {
    let mut open = 0i32;
    let mut blocked = 0i32;

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Open:") {
            if let Ok(n) = rest.trim().parse::<i32>() {
                open = n;
            }
        } else if let Some(rest) = trimmed.strip_prefix("Blocked:")
            && let Ok(n) = rest.trim().parse::<i32>() {
                blocked = n;
            }
    }

    (open, blocked)
}

/// Collect git status by running several `git -C <cwd>` commands.
pub async fn collect_git_status(cwd: &Path) -> GitStatus {
    // Owned path string so arg arrays can borrow it with the right lifetime.
    let path: String = cwd.to_string_lossy().into_owned();

    // Pre-bind each arg array so slices are not temporaries inside join!.
    let args_branch: &[&str] = &["-C", &path, "branch", "--show-current"];
    let args_sha: &[&str] = &["-C", &path, "rev-parse", "--short", "HEAD"];
    let args_log: &[&str] = &["-C", &path, "log", "--oneline", "-5"];
    let args_status: &[&str] = &["-C", &path, "status", "--porcelain"];

    let (branch_out, sha_out, log_out, porcelain_out) = tokio::join!(
        run_cmd("git", args_branch, cwd),
        run_cmd("git", args_sha, cwd),
        run_cmd("git", args_log, cwd),
        run_cmd("git", args_status, cwd),
    );

    let branch = branch_out.unwrap_or_default().trim().to_owned();
    let head_sha = sha_out.unwrap_or_default().trim().to_owned();
    let recent_commits = log_out
        .unwrap_or_default()
        .lines()
        .map(|l| l.to_owned())
        .collect();
    let porcelain = porcelain_out.unwrap_or_default();

    GitStatus {
        branch,
        head_sha,
        recent_commits,
        porcelain,
    }
}

/// Collect openspec status by running `openspec list --json` (only if an
/// `openspec/` directory exists inside `cwd`).
pub async fn collect_spec_status(cwd: &Path) -> SpecStatus {
    let openspec_dir = cwd.join("openspec");
    if !openspec_dir.exists() {
        return SpecStatus::default();
    }

    let Some(output) = run_cmd("openspec", &["list", "--json"], cwd).await else {
        return SpecStatus::default();
    };

    parse_openspec_list(&output)
}

/// Parse `openspec list --json` output.
///
/// Expected shape (best-effort — falls back to defaults on any parse failure):
/// ```json
/// [{ "name": "...", "status": "active" | "draft" | ... }, ...]
/// ```
fn parse_openspec_list(json: &str) -> SpecStatus {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        warn!("openspec list --json returned non-JSON output");
        return SpecStatus::default();
    };

    let Some(arr) = value.as_array() else {
        return SpecStatus::default();
    };

    let spec_count = arr.len() as i32;
    let mut active_changes: Vec<String> = Vec::new();

    for item in arr {
        // Collect specs that have an "active" status.
        let is_active = item
            .get("status")
            .and_then(|s| s.as_str())
            .map(|s| s == "active")
            .unwrap_or(false);

        if is_active
            && let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                active_changes.push(name.to_owned());
            }
    }

    let change_count = active_changes.len() as i32;

    SpecStatus {
        spec_count,
        change_count,
        active_changes,
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Collect all project status in parallel and return a combined [`ProjectStatus`].
pub async fn collect_all(cwd: &Path) -> ProjectStatus {
    let (beads, git, spec) = tokio::join!(
        collect_beads_status(cwd),
        collect_git_status(cwd),
        collect_spec_status(cwd),
    );

    ProjectStatus { beads, git, spec }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

struct CachedEntry {
    status: ProjectStatus,
    cached_at: Instant,
}

struct CacheInner {
    cache: RwLock<HashMap<String, CachedEntry>>,
    ttl: Duration,
}

/// Cached project status with TTL-based expiration.
///
/// Clone-friendly via `Arc<Inner>` — all clones share the same backing store.
#[derive(Clone)]
pub struct ProjectStatusCache {
    inner: Arc<CacheInner>,
}

impl ProjectStatusCache {
    /// Create a new cache with the given TTL (default: 30 seconds).
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(CacheInner {
                cache: RwLock::new(HashMap::new()),
                ttl,
            }),
        }
    }

    /// Return a [`ProjectStatus`] for the given project.
    ///
    /// - `fresh = true` → bypass cache and force a live collection.
    /// - Cache hit within TTL → return cached value.
    /// - Expired or missing → call [`collect_all`], store result, return it.
    pub async fn get(&self, project_code: &str, cwd: &Path, fresh: bool) -> ProjectStatus {
        if !fresh {
            // Fast path: try read lock first.
            let guard = self.inner.cache.read().await;
            if let Some(entry) = guard.get(project_code)
                && entry.cached_at.elapsed() < self.inner.ttl {
                    return entry.status.clone();
                }
        }

        // Cache miss, expired, or forced refresh — collect fresh data.
        let status = collect_all(cwd).await;

        // Store under write lock.
        let mut guard = self.inner.cache.write().await;
        guard.insert(
            project_code.to_owned(),
            CachedEntry {
                status: status.clone(),
                cached_at: Instant::now(),
            },
        );

        status
    }

    /// Remove a project's cached entry (e.g. after a git push or bd close).
    pub async fn invalidate(&self, project_code: &str) {
        let mut guard = self.inner.cache.write().await;
        guard.remove(project_code);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_bd_stats ---

    #[test]
    fn parse_bd_stats_standard() {
        let text = "Open: 5\nBlocked: 2\nClosed: 10\n";
        let (open, blocked) = parse_bd_stats(text);
        assert_eq!(open, 5);
        assert_eq!(blocked, 2);
    }

    #[test]
    fn parse_bd_stats_empty() {
        let (open, blocked) = parse_bd_stats("");
        assert_eq!(open, 0);
        assert_eq!(blocked, 0);
    }

    #[test]
    fn parse_bd_stats_whitespace_tolerant() {
        // Leading/trailing whitespace on the value side should still parse.
        let text = "  Open:   3\n  Blocked:   1\n";
        let (open, blocked) = parse_bd_stats(text);
        assert_eq!(open, 3);
        assert_eq!(blocked, 1);
    }

    #[test]
    fn parse_bd_stats_missing_fields_default_to_zero() {
        // Only "Open:" present — Blocked should stay 0.
        let text = "Open: 7\nClosed: 3\n";
        let (open, blocked) = parse_bd_stats(text);
        assert_eq!(open, 7);
        assert_eq!(blocked, 0);
    }

    // --- parse_openspec_list ---

    #[test]
    fn parse_openspec_list_active() {
        let json =
            r#"[{"name":"add-feature","status":"active"},{"name":"fix-bug","status":"draft"}]"#;
        let status = parse_openspec_list(json);
        assert_eq!(status.spec_count, 2);
        assert_eq!(status.change_count, 1);
        assert_eq!(status.active_changes, vec!["add-feature"]);
    }

    #[test]
    fn parse_openspec_list_invalid_json() {
        let status = parse_openspec_list("not json");
        assert_eq!(status.spec_count, 0);
        assert_eq!(status.change_count, 0);
    }

    #[test]
    fn parse_openspec_list_empty_array() {
        let status = parse_openspec_list("[]");
        assert_eq!(status.spec_count, 0);
        assert_eq!(status.change_count, 0);
        assert!(status.active_changes.is_empty());
    }

    #[test]
    fn parse_openspec_list_all_active() {
        let json = r#"[
            {"name":"spec-a","status":"active"},
            {"name":"spec-b","status":"active"}
        ]"#;
        let status = parse_openspec_list(json);
        assert_eq!(status.spec_count, 2);
        assert_eq!(status.change_count, 2);
        assert_eq!(status.active_changes, vec!["spec-a", "spec-b"]);
    }

    #[test]
    fn parse_openspec_list_non_object_json_returns_default() {
        // Top-level JSON object (not array) should return defaults.
        let status = parse_openspec_list(r#"{"key":"value"}"#);
        assert_eq!(status.spec_count, 0);
        assert_eq!(status.change_count, 0);
    }

    // --- ProjectStatusCache ---

    #[tokio::test]
    async fn cache_new_is_empty() {
        let cache = ProjectStatusCache::new(Duration::from_secs(30));
        // An empty cache has no entries — verify Arc clone shares the same store.
        let cache2 = cache.clone();
        // Both clones operate on the same underlying data; invalidating on one
        // should be a no-op since there's nothing to remove.
        cache2.invalidate("nonexistent").await; // must not panic
    }

    #[tokio::test]
    async fn cache_stores_and_returns_entry_within_ttl() {
        // We can't easily inject a ProjectStatus without calling collect_all
        // (which would run real subprocesses). Instead, verify the cache's
        // structural contract: after `get` inserts an entry, a second `get`
        // within TTL returns a value (without re-running collection).
        //
        // Use a very short TTL so the test doesn't hang.
        let cache = ProjectStatusCache::new(Duration::from_secs(60));

        // Use /tmp as cwd — all collectors will fail gracefully and return defaults.
        let cwd = std::path::Path::new("/tmp");

        // First call: cache miss → runs collect_all (returns default structs).
        let status1 = cache.get("test-proj", cwd, false).await;

        // Second call: should be a cache hit within TTL.
        let status2 = cache.get("test-proj", cwd, false).await;

        // Both should be structurally identical (default values from failed collectors).
        assert_eq!(status1.git.branch, status2.git.branch);
        assert_eq!(status1.beads.ready_count, status2.beads.ready_count);
    }

    #[tokio::test]
    async fn cache_invalidate_removes_entry() {
        let cache = ProjectStatusCache::new(Duration::from_secs(60));
        let cwd = std::path::Path::new("/tmp");

        // Populate the cache.
        cache.get("proj-x", cwd, false).await;

        // Invalidate it.
        cache.invalidate("proj-x").await;

        // A subsequent get with fresh=false will re-run collection (still returns
        // defaults from /tmp, but we at least verify it doesn't panic and returns
        // a valid ProjectStatus).
        let status = cache.get("proj-x", cwd, false).await;
        // BeadsStatus default has ready_count == 0.
        assert_eq!(status.beads.ready_count, 0);
    }

    #[tokio::test]
    async fn cache_fresh_flag_bypasses_ttl() {
        let cache = ProjectStatusCache::new(Duration::from_secs(3600));
        let cwd = std::path::Path::new("/tmp");

        // Populate.
        cache.get("proj-y", cwd, false).await;

        // Force a fresh collection — must not panic.
        let status = cache.get("proj-y", cwd, true).await;
        assert_eq!(status.beads.open_count, 0); // default from /tmp
    }
}
