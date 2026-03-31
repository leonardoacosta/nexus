//! Credential Pool Service
//!
//! Manages a pool of Claude Code OAuth credential files stored in
//! `~/.config/nexus/credentials/`. Each JSON file contains a
//! `claudeAiOauth` object with `accessToken` and `expiresAt`.
//!
//! The service:
//! - Scans and parses credential files on startup
//! - Watches for file changes (create/modify/remove) with 1s debounce
//! - Polls the Anthropic usage API every 5 minutes
//! - Persists usage cache to `~/.config/nexus/state/usage-cache.json`
//! - Supports atomic symlink swap for credential rotation
//! - Operates in passthrough mode when no credentials directory exists

use crate::services::Service;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use nexus_core::credentials::{
    best_available, query_usage, AccountUsage, CachedUsage, CredentialAccount, UsageCache,
};
use nexus_core::paths;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify, RwLock};
use tracing::{debug, error, info, warn};

// ── Constants ──────────────────────────────────────────────────────────────

/// Subdirectory under `~/.config/nexus/` that holds credential JSON files.
const CREDENTIALS_DIR: &str = "credentials";

/// Subdirectory under `~/.config/nexus/` for persisted state.
const STATE_DIR: &str = "state";

/// Filename for the persisted usage cache.
const USAGE_CACHE_FILE: &str = "usage-cache.json";

/// How often the proactive usage poll runs (seconds).
const POLL_INTERVAL_SECS: u64 = 300; // 5 minutes

/// Maximum age (seconds) of cached usage data considered fresh.
const CACHE_FRESHNESS_SECS: i64 = 600; // 10 minutes

/// File-watcher debounce window (seconds).
const DEBOUNCE_SECS: u64 = 1;

// ── Credential File Format ─────────────────────────────────────────────────

/// Shape of a Claude Code `.credentials.json` file.
#[derive(Debug, Deserialize)]
struct CredentialFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OAuthEntry,
}

#[derive(Debug, Deserialize)]
struct OAuthEntry {
    #[serde(rename = "accessToken")]
    access_token: String,
    /// Unix timestamp (seconds since epoch) — may be absent.
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
}

// ── Shared Pool State ──────────────────────────────────────────────────────

/// Thread-safe inner state shared between the service, HTTP handlers, and
/// the socket service for credential rotation.
#[derive(Debug)]
pub struct CredentialPool {
    pub accounts: RwLock<Vec<CredentialAccount>>,
    pub active_account: RwLock<Option<String>>,
    /// Notify handle used to reset the poll interval (e.g., after `poll_now`).
    poll_notify: Notify,
    http_client: reqwest::Client,
}

impl CredentialPool {
    fn new(http_client: reqwest::Client) -> Self {
        Self {
            accounts: RwLock::new(Vec::new()),
            active_account: RwLock::new(None),
            poll_notify: Notify::new(),
            http_client,
        }
    }

    /// Return the best available credential account (lowest utilization,
    /// not expired, not exhausted). Returns `None` when the pool is empty
    /// or all accounts are unavailable.
    pub async fn best_available(&self) -> Option<CredentialAccount> {
        let accounts = self.accounts.read().await;
        best_available(&accounts).cloned()
    }

    /// Immediately poll all accounts for fresh usage data, bypassing the
    /// interval timer. Resets the timer so the next proactive poll is a
    /// full interval from now.
    pub async fn poll_now(&self) {
        self.poll_all_accounts().await;
        // Wake the poll loop so it resets its interval.
        self.poll_notify.notify_one();
    }

    /// Atomic symlink swap: point `~/.claude/.credentials.json` at `target`.
    pub async fn swap_credential(&self, target: &CredentialAccount) -> Result<()> {
        let link_path = paths::home_dir().join(".claude").join(".credentials.json");

        // Remove existing file/symlink (ignore if missing).
        tokio::fs::remove_file(&link_path).await.ok();

        // Create new symlink.
        tokio::fs::symlink(&target.path, &link_path)
            .await
            .with_context(|| {
                format!(
                    "failed to symlink {} -> {}",
                    link_path.display(),
                    target.path.display()
                )
            })?;

        *self.active_account.write().await = Some(target.name.clone());
        info!(
            account = %target.name,
            path = %target.path.display(),
            "Swapped active credential"
        );

        Ok(())
    }

    // ── Internal helpers ───────────────────────────────────────────────

    /// Poll the Anthropic usage API for every account and persist results.
    async fn poll_all_accounts(&self) {
        let snapshot: Vec<CredentialAccount> = self.accounts.read().await.clone();
        if snapshot.is_empty() {
            return;
        }

        let now = Utc::now();
        let mut cache = UsageCache::default();

        for acct in &snapshot {
            match query_usage(&self.http_client, &acct.access_token).await {
                Ok(usage) => {
                    debug!(account = %acct.name, "polled usage OK");
                    cache.accounts.insert(
                        acct.name.clone(),
                        CachedUsage {
                            five_hour: usage.five_hour.clone(),
                            seven_day: usage.seven_day.clone(),
                            last_polled: now,
                        },
                    );
                }
                Err(e) => {
                    warn!(account = %acct.name, error = %e, "failed to poll usage");
                }
            }
        }

        // Update in-memory accounts with fresh usage data.
        {
            let mut accounts = self.accounts.write().await;
            for acct in accounts.iter_mut() {
                if let Some(cached) = cache.accounts.get(&acct.name) {
                    acct.usage = Some(AccountUsage {
                        five_hour: cached.five_hour.clone(),
                        seven_day: cached.seven_day.clone(),
                    });
                    acct.last_polled = Some(cached.last_polled);
                }
            }
        }

        // Persist to disk.
        let cache_path = usage_cache_path();
        if let Some(parent) = cache_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!(error = %e, "failed to create state dir for usage cache");
                return;
            }
        }
        if let Err(e) = cache.save(&cache_path) {
            warn!(error = %e, "failed to persist usage cache");
        } else {
            debug!("usage cache persisted to {}", cache_path.display());
        }
    }
}

// ── Service ────────────────────────────────────────────────────────────────

/// Credential Pool Service — file watcher + usage poller + symlink swapper.
pub struct CredentialPoolService {
    pool: Arc<CredentialPool>,
    healthy: Arc<AtomicBool>,
}

impl CredentialPoolService {
    /// Construct a new service with a shared HTTP client.
    pub fn new(http_client: reqwest::Client) -> Self {
        Self {
            pool: Arc::new(CredentialPool::new(http_client)),
            healthy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Get a shared handle to the inner pool state.
    pub fn pool(&self) -> Arc<CredentialPool> {
        Arc::clone(&self.pool)
    }
}

#[async_trait::async_trait]
impl Service for CredentialPoolService {
    fn name(&self) -> &'static str {
        "credential-pool"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        let creds_dir = credentials_dir();

        // ── Passthrough mode [3.6] ─────────────────────────────────────
        if !creds_dir.is_dir() {
            info!(
                "Credential pool passthrough: {} does not exist, service is a no-op",
                creds_dir.display()
            );
            // Block until shutdown without consuming resources.
            let _ = shutdown_rx.recv().await;
            return Ok(());
        }

        let initial = scan_credential_files(&creds_dir);
        if initial.is_empty() {
            info!(
                "Credential pool passthrough: {} exists but is empty, service is a no-op",
                creds_dir.display()
            );
            let _ = shutdown_rx.recv().await;
            return Ok(());
        }

        info!(
            "Credential pool starting with {} account(s) from {}",
            initial.len(),
            creds_dir.display()
        );

        // Load cached usage if fresh.
        let cache_path = usage_cache_path();
        let cached = load_fresh_cache(&cache_path);

        // Merge cached usage into accounts.
        let accounts: Vec<CredentialAccount> = initial
            .into_iter()
            .map(|mut acct| {
                if let Some(ref cache) = cached {
                    if let Some(cu) = cache.accounts.get(&acct.name) {
                        acct.usage = Some(AccountUsage {
                            five_hour: cu.five_hour.clone(),
                            seven_day: cu.seven_day.clone(),
                        });
                        acct.last_polled = Some(cu.last_polled);
                    }
                }
                acct
            })
            .collect();

        for a in &accounts {
            info!(
                "  account={} expired={} utilization={:.2}",
                a.name,
                a.is_expired(),
                a.effective_utilization()
            );
        }

        *self.pool.accounts.write().await = accounts;
        self.healthy.store(true, Ordering::SeqCst);

        // ── File watcher [3.2] ─────────────────────────────────────────
        let (notify_tx, mut notify_rx) = mpsc::channel::<Event>(100);

        let mut watcher = RecommendedWatcher::new(
            move |result: std::result::Result<Event, notify::Error>| match result {
                Ok(event) => {
                    let _ = notify_tx.try_send(event);
                }
                Err(e) => {
                    error!("[credential-pool] watch error: {}", e);
                }
            },
            Config::default(),
        )
        .context("failed to create credential pool file watcher")?;

        watcher
            .watch(&creds_dir, RecursiveMode::NonRecursive)
            .with_context(|| format!("failed to watch {}", creds_dir.display()))?;

        info!(
            "[credential-pool] watching {} for changes",
            creds_dir.display()
        );

        // ── Poll + watch loop [3.3] ────────────────────────────────────
        let mut poll_interval = tokio::time::interval(Duration::from_secs(POLL_INTERVAL_SECS));
        // The first tick fires immediately — use it for an initial poll.
        poll_interval.tick().await;

        let mut debounce_tracker = DebounceTracker::new(Duration::from_secs(DEBOUNCE_SECS));
        let pool = Arc::clone(&self.pool);
        let pool_for_poll = Arc::clone(&self.pool);

        // Kick off an initial poll in the background.
        let poll_init = Arc::clone(&self.pool);
        tokio::spawn(async move {
            poll_init.poll_all_accounts().await;
        });

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("[credential-pool] shutting down");
                    break;
                }
                _ = poll_interval.tick() => {
                    debug!("[credential-pool] proactive poll tick");
                    pool_for_poll.poll_all_accounts().await;
                }
                _ = pool.poll_notify.notified() => {
                    // poll_now() was called — reset the interval by consuming the
                    // pending tick and continuing.
                    poll_interval.reset();
                    debug!("[credential-pool] poll interval reset by poll_now()");
                }
                Some(event) = notify_rx.recv() => {
                    if let Some((path, is_remove)) = classify_event(&event, &creds_dir) {
                        if debounce_tracker.should_process(&path) {
                            handle_fs_event(&pool, &path, is_remove, &creds_dir).await;
                        } else {
                            debug!("[credential-pool] debounced event for {}", path.display());
                        }
                    }
                }
            }
        }

        drop(watcher);
        self.healthy.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn health_check(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }
}

// ── File-system event handling ─────────────────────────────────────────────

/// Classify a `notify::Event` into (path, is_remove) if it's relevant.
fn classify_event(event: &Event, watch_dir: &Path) -> Option<(PathBuf, bool)> {
    let is_relevant = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );
    if !is_relevant {
        return None;
    }
    let is_remove = matches!(event.kind, EventKind::Remove(_));

    for path in &event.paths {
        if path.parent() != Some(watch_dir) {
            continue;
        }
        if is_credential_json(path) {
            return Some((path.clone(), is_remove));
        }
    }
    None
}

/// Handle a file-system event on a credential file.
async fn handle_fs_event(
    pool: &Arc<CredentialPool>,
    path: &Path,
    is_remove: bool,
    _creds_dir: &Path,
) {
    let name = derive_account_name(path);

    if is_remove {
        let mut accounts = pool.accounts.write().await;
        let before = accounts.len();
        accounts.retain(|a| a.name != name);
        if accounts.len() < before {
            info!(account = %name, "removed credential from pool");
        }
        return;
    }

    // Create or modify — re-parse the file.
    match parse_credential_file(path) {
        Ok(acct) => {
            let mut accounts = pool.accounts.write().await;
            if let Some(existing) = accounts.iter_mut().find(|a| a.name == acct.name) {
                existing.access_token = acct.access_token;
                existing.expires_at = acct.expires_at;
                existing.path = acct.path;
                info!(account = %name, "updated credential in pool");
            } else {
                info!(account = %name, "added new credential to pool");
                accounts.push(acct);
            }
        }
        Err(e) => {
            warn!(
                path = %path.display(),
                error = %e,
                "failed to parse credential file"
            );
        }
    }
}

// ── Debounce ───────────────────────────────────────────────────────────────

struct DebounceTracker {
    last_event: std::collections::HashMap<PathBuf, tokio::time::Instant>,
    window: Duration,
}

impl DebounceTracker {
    fn new(window: Duration) -> Self {
        Self {
            last_event: std::collections::HashMap::new(),
            window,
        }
    }

    fn should_process(&mut self, path: &Path) -> bool {
        let now = tokio::time::Instant::now();
        if let Some(last) = self.last_event.get(path) {
            if now.duration_since(*last) < self.window {
                self.last_event.insert(path.to_path_buf(), now);
                return false;
            }
        }
        self.last_event.insert(path.to_path_buf(), now);
        true
    }
}

// ── Parsing helpers ────────────────────────────────────────────────────────

/// Path to the credentials directory.
fn credentials_dir() -> PathBuf {
    paths::nexus_config_dir().join(CREDENTIALS_DIR)
}

/// Path to the usage cache file.
fn usage_cache_path() -> PathBuf {
    paths::nexus_config_dir()
        .join(STATE_DIR)
        .join(USAGE_CACHE_FILE)
}

/// Check if a file is a `.json` file in the credentials directory.
fn is_credential_json(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
}

/// Derive the account name from a filename.
///
/// `acct-personal.json` -> `"personal"`
/// `work.json` -> `"work"`
fn derive_account_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    // Strip common prefixes.
    let name = stem
        .strip_prefix("acct-")
        .or_else(|| stem.strip_prefix("acct_"))
        .unwrap_or(stem);
    name.to_string()
}

/// Parse a single credential JSON file into a `CredentialAccount`.
fn parse_credential_file(path: &Path) -> Result<CredentialAccount> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let cred: CredentialFile = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;

    let expires_at = cred.claude_ai_oauth.expires_at.map(|ts| {
        DateTime::from_timestamp(ts, 0).unwrap_or_else(|| {
            warn!(
                path = %path.display(),
                ts,
                "invalid expiresAt timestamp, treating as no expiry"
            );
            Utc::now() + chrono::Duration::days(365)
        })
    });

    Ok(CredentialAccount {
        name: derive_account_name(path),
        path: path.to_path_buf(),
        access_token: cred.claude_ai_oauth.access_token,
        expires_at,
        usage: None,
        last_polled: None,
    })
}

/// Scan the credentials directory for all JSON files and parse them.
fn scan_credential_files(dir: &Path) -> Vec<CredentialAccount> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            warn!(
                dir = %dir.display(),
                error = %e,
                "failed to scan credentials directory"
            );
            return Vec::new();
        }
    };

    let mut accounts = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_credential_json(&path) {
            match parse_credential_file(&path) {
                Ok(acct) => accounts.push(acct),
                Err(e) => {
                    debug!(
                        path = %path.display(),
                        error = %e,
                        "skipping unparseable credential file"
                    );
                }
            }
        }
    }
    accounts
}

/// Load the usage cache if it exists and its entries are fresh enough.
fn load_fresh_cache(path: &Path) -> Option<UsageCache> {
    let cache = UsageCache::load(path).ok()?;
    let now = Utc::now();
    let freshness = chrono::Duration::seconds(CACHE_FRESHNESS_SECS);

    // Check if at least one entry is fresh.
    let has_fresh = cache
        .accounts
        .values()
        .any(|cu| now.signed_duration_since(cu.last_polled) < freshness);

    if has_fresh {
        debug!("loaded fresh usage cache from {}", path.display());
        Some(cache)
    } else {
        debug!("usage cache at {} is stale, ignoring", path.display());
        None
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_derive_account_name() {
        assert_eq!(
            derive_account_name(Path::new("/tmp/acct-personal.json")),
            "personal"
        );
        assert_eq!(
            derive_account_name(Path::new("/tmp/acct_work.json")),
            "work"
        );
        assert_eq!(derive_account_name(Path::new("/tmp/team.json")), "team");
        assert_eq!(derive_account_name(Path::new("/tmp/acct-.json")), "");
    }

    #[test]
    fn test_is_credential_json() {
        assert!(is_credential_json(Path::new("acct-personal.json")));
        assert!(is_credential_json(Path::new("work.JSON")));
        assert!(!is_credential_json(Path::new("readme.md")));
        assert!(!is_credential_json(Path::new("noext")));
    }

    #[test]
    fn test_parse_credential_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("acct-personal.json");
        fs::write(
            &path,
            r#"{
                "claudeAiOauth": {
                    "accessToken": "tok-abc123",
                    "expiresAt": 1743480000
                }
            }"#,
        )
        .unwrap();

        let acct = parse_credential_file(&path).unwrap();
        assert_eq!(acct.name, "personal");
        assert_eq!(acct.access_token, "tok-abc123");
        assert!(acct.expires_at.is_some());
        assert!(acct.usage.is_none());
    }

    #[test]
    fn test_parse_credential_file_no_expiry() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("acct-work.json");
        fs::write(
            &path,
            r#"{
                "claudeAiOauth": {
                    "accessToken": "tok-xyz789"
                }
            }"#,
        )
        .unwrap();

        let acct = parse_credential_file(&path).unwrap();
        assert_eq!(acct.name, "work");
        assert!(acct.expires_at.is_none());
    }

    #[test]
    fn test_parse_credential_file_bad_json() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("bad.json");
        fs::write(&path, "not json").unwrap();
        assert!(parse_credential_file(&path).is_err());
    }

    #[test]
    fn test_scan_credential_files() {
        let tmp = TempDir::new().unwrap();

        // Valid credential
        fs::write(
            tmp.path().join("acct-a.json"),
            r#"{"claudeAiOauth":{"accessToken":"tok-a","expiresAt":1743480000}}"#,
        )
        .unwrap();

        // Another valid credential
        fs::write(
            tmp.path().join("acct-b.json"),
            r#"{"claudeAiOauth":{"accessToken":"tok-b"}}"#,
        )
        .unwrap();

        // Not JSON — should be skipped
        fs::write(tmp.path().join("readme.md"), "# readme").unwrap();

        // Invalid JSON — should be skipped
        fs::write(tmp.path().join("broken.json"), "not json").unwrap();

        let accounts = scan_credential_files(tmp.path());
        assert_eq!(accounts.len(), 2);

        let names: Vec<&str> = accounts.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
    }

    #[test]
    fn test_scan_nonexistent_dir() {
        let accounts = scan_credential_files(Path::new("/tmp/nonexistent-nx-test-dir"));
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_classify_event_create() {
        let dir = Path::new("/home/user/.config/nexus/credentials");
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![dir.join("acct-new.json")],
            attrs: Default::default(),
        };
        let result = classify_event(&event, dir);
        assert!(result.is_some());
        let (path, is_remove) = result.unwrap();
        assert_eq!(path, dir.join("acct-new.json"));
        assert!(!is_remove);
    }

    #[test]
    fn test_classify_event_remove() {
        let dir = Path::new("/home/user/.config/nexus/credentials");
        let event = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![dir.join("acct-old.json")],
            attrs: Default::default(),
        };
        let result = classify_event(&event, dir);
        assert!(result.is_some());
        let (_, is_remove) = result.unwrap();
        assert!(is_remove);
    }

    #[test]
    fn test_classify_event_ignores_non_json() {
        let dir = Path::new("/home/user/.config/nexus/credentials");
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![dir.join("readme.md")],
            attrs: Default::default(),
        };
        assert!(classify_event(&event, dir).is_none());
    }

    #[test]
    fn test_classify_event_ignores_subdirectory() {
        let dir = Path::new("/home/user/.config/nexus/credentials");
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![dir.join("subdir").join("acct-new.json")],
            attrs: Default::default(),
        };
        assert!(classify_event(&event, dir).is_none());
    }

    #[tokio::test]
    async fn test_credential_pool_best_available_empty() {
        let pool = CredentialPool::new(reqwest::Client::new());
        assert!(pool.best_available().await.is_none());
    }

    #[tokio::test]
    async fn test_credential_pool_service_passthrough() {
        // When no credentials dir exists, start() should block until shutdown.
        let service = CredentialPoolService::new(reqwest::Client::new());
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move { service.start(shutdown_rx).await });

        // Give the service a moment to reach the recv.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let _ = shutdown_tx.send(()).await;

        let result = tokio::time::timeout(Duration::from_secs(5), handle).await;
        assert!(result.is_ok(), "service should shut down within timeout");
    }

    #[test]
    fn test_debounce_tracker() {
        let mut tracker = DebounceTracker::new(Duration::from_secs(1));
        let path = Path::new("/tmp/acct-test.json");

        assert!(tracker.should_process(path));
        assert!(!tracker.should_process(path));
    }

    #[test]
    fn test_load_fresh_cache_nonexistent() {
        assert!(load_fresh_cache(Path::new("/tmp/nonexistent-nx-cache.json")).is_none());
    }

    #[test]
    fn test_load_fresh_cache_stale() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("usage-cache.json");

        let stale_time = Utc::now() - chrono::Duration::minutes(20);
        let mut cache = UsageCache::default();
        cache.accounts.insert(
            "old".to_string(),
            CachedUsage {
                five_hour: nexus_core::credentials::UsageWindow {
                    utilization: 0.5,
                    resets_at: Utc::now(),
                },
                seven_day: nexus_core::credentials::UsageWindow {
                    utilization: 0.5,
                    resets_at: Utc::now(),
                },
                last_polled: stale_time,
            },
        );
        cache.save(&path).unwrap();

        assert!(load_fresh_cache(&path).is_none());
    }

    #[test]
    fn test_load_fresh_cache_valid() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("usage-cache.json");

        let mut cache = UsageCache::default();
        cache.accounts.insert(
            "fresh".to_string(),
            CachedUsage {
                five_hour: nexus_core::credentials::UsageWindow {
                    utilization: 0.3,
                    resets_at: Utc::now() + chrono::Duration::hours(3),
                },
                seven_day: nexus_core::credentials::UsageWindow {
                    utilization: 0.6,
                    resets_at: Utc::now() + chrono::Duration::days(5),
                },
                last_polled: Utc::now(),
            },
        );
        cache.save(&path).unwrap();

        let loaded = load_fresh_cache(&path);
        assert!(loaded.is_some());
        assert!(loaded.unwrap().accounts.contains_key("fresh"));
    }
}
