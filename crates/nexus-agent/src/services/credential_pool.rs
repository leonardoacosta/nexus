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
use sentry;
use chrono::{DateTime, Utc};
use crate::usage_api::query_usage;
use nexus_core::credentials::{
    AccountUsage, CachedUsage, CredentialAccount, UsageCache, best_available, fingerprint_token,
    is_managed_symlink, sanitize_account_name,
};
use nexus_core::db::{CredentialPollRecord, NexusDb};
use nexus_core::paths;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock, mpsc};
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

/// Duration of the debounce window after a credential swap.
/// During this window, new rate limit events trigger "continue" without re-swap.
const SWAP_DEBOUNCE_SECS: u64 = 180; // 3 minutes

/// Thread-safe inner state shared between the service, HTTP handlers, and
/// the socket service for credential rotation.
#[derive(Debug)]
pub struct CredentialPool {
    pub accounts: RwLock<Vec<CredentialAccount>>,
    pub active_account: RwLock<Option<String>>,
    /// Notify handle used to reset the poll interval (e.g., after `poll_now`).
    poll_notify: Notify,
    http_client: reqwest::Client,
    /// Time of the last successful credential swap (for debounce).
    pub last_swap_time: RwLock<Option<Instant>>,
    /// Account name that was last swapped to (for debounce logging).
    pub last_swap_account: RwLock<Option<String>>,
    /// Optional SQLite backing store for credential analytics.
    pub db: Option<Arc<NexusDb>>,
}

impl CredentialPool {
    fn new(http_client: reqwest::Client) -> Self {
        Self {
            accounts: RwLock::new(Vec::new()),
            active_account: RwLock::new(None),
            poll_notify: Notify::new(),
            http_client,
            last_swap_time: RwLock::new(None),
            last_swap_account: RwLock::new(None),
            db: None,
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

    /// Check if the debounce window is active (within 3 minutes of last swap).
    pub async fn is_debounce_active(&self) -> bool {
        let guard = self.last_swap_time.read().await;
        guard.is_some_and(|t| t.elapsed() < Duration::from_secs(SWAP_DEBOUNCE_SECS))
    }

    /// Record a successful swap for debounce tracking.
    pub async fn record_swap(&self, account_name: &str) {
        *self.last_swap_time.write().await = Some(Instant::now());
        *self.last_swap_account.write().await = Some(account_name.to_string());
        sentry::add_breadcrumb(sentry::Breadcrumb {
            ty: "info".into(),
            category: Some("credential.rotation".into()),
            message: Some(format!("Rotation triggered: swapped to account '{}'", account_name)),
            level: sentry::Level::Info,
            ..Default::default()
        });
    }

    /// Atomic symlink swap: point `~/.claude/.credentials.json` at `target`.
    #[tracing::instrument(name = "credential.rotation", skip(self), fields(target_account = %target.name))]
    pub async fn swap_credential(&self, target: &CredentialAccount) -> Result<()> {
        let link_path = paths::home_dir().join(".claude").join(".credentials.json");

        sentry::add_breadcrumb(sentry::Breadcrumb {
            ty: "info".into(),
            category: Some("credential.rotation".into()),
            message: Some(format!("Swap initiated for account '{}'", target.name)),
            level: sentry::Level::Info,
            ..Default::default()
        });

        // Atomic swap via temp symlink + rename(2).
        // rename(2) on Unix is atomic — no gap where the file is missing.
        let tmp_link = link_path.with_extension("tmp");

        // Remove stale temp symlink if it exists (from a previous crash).
        tokio::fs::remove_file(&tmp_link).await.ok();

        // Create temp symlink pointing to the new target.
        let symlink_result = tokio::fs::symlink(&target.path, &tmp_link)
            .await
            .with_context(|| {
                format!(
                    "failed to create temp symlink {} -> {}",
                    tmp_link.display(),
                    target.path.display()
                )
            });
        if let Err(ref e) = symlink_result {
            sentry::add_breadcrumb(sentry::Breadcrumb {
                ty: "error".into(),
                category: Some("credential.rotation".into()),
                message: Some(format!("Swap failed for account '{}': {}", target.name, e)),
                level: sentry::Level::Error,
                ..Default::default()
            });
            return symlink_result.map(|_| ());
        }

        // Atomic rename: tmp -> real. This is a single rename(2) syscall.
        let rename_result = tokio::fs::rename(&tmp_link, &link_path)
            .await
            .with_context(|| {
                format!(
                    "failed to atomically swap {} -> {}",
                    tmp_link.display(),
                    link_path.display()
                )
            });
        if let Err(ref e) = rename_result {
            sentry::add_breadcrumb(sentry::Breadcrumb {
                ty: "error".into(),
                category: Some("credential.rotation".into()),
                message: Some(format!("Swap failed for account '{}': {}", target.name, e)),
                level: sentry::Level::Error,
                ..Default::default()
            });
            return rename_result.map(|_| ());
        }

        *self.active_account.write().await = Some(target.name.clone());
        info!(
            account = %target.name,
            path = %target.path.display(),
            "Swapped active credential"
        );

        sentry::add_breadcrumb(sentry::Breadcrumb {
            ty: "info".into(),
            category: Some("credential.rotation".into()),
            message: Some(format!(
                "Swap succeeded: active credential is now '{}'",
                target.name
            )),
            level: sentry::Level::Info,
            ..Default::default()
        });

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
                    sentry::add_breadcrumb(sentry::Breadcrumb {
                        ty: "info".into(),
                        category: Some("credential.rotation".into()),
                        message: Some(format!(
                            "Poll succeeded for account '{}': 5h={:.2} 7d={:.2}",
                            acct.name,
                            usage.five_hour.utilization,
                            usage.seven_day.utilization,
                        )),
                        level: sentry::Level::Info,
                        ..Default::default()
                    });
                    cache.accounts.insert(
                        acct.name.clone(),
                        CachedUsage {
                            five_hour: usage.five_hour.clone(),
                            seven_day: usage.seven_day.clone(),
                            last_polled: now,
                        },
                    );

                    // [4.1] Write poll to DB if available.
                    if let Some(ref db) = self.db {
                        let record = CredentialPollRecord {
                            timestamp: now.to_rfc3339(),
                            account: acct.name.clone(),
                            five_hour_utilization: Some(usage.five_hour.utilization as f64),
                            seven_day_utilization: Some(usage.seven_day.utilization as f64),
                            five_hour_resets_at: Some(usage.five_hour.resets_at.to_rfc3339()),
                            seven_day_resets_at: Some(usage.seven_day.resets_at.to_rfc3339()),
                        };
                        if let Err(e) = db.insert_credential_poll(&record) {
                            warn!(account = %acct.name, error = %e, "failed to insert credential poll");
                        }
                    }
                }
                Err(e) => {
                    warn!(account = %acct.name, error = %e, "failed to poll usage");
                    sentry::add_breadcrumb(sentry::Breadcrumb {
                        ty: "error".into(),
                        category: Some("credential.rotation".into()),
                        message: Some(format!(
                            "Poll failed for account '{}': {}",
                            acct.name, e
                        )),
                        level: sentry::Level::Error,
                        ..Default::default()
                    });
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

        // [4.4] DB is now source of truth — still persist disk cache as fallback
        // for startup without DB, but this is secondary to the DB writes above.
        let cache_path = usage_cache_path();
        if let Some(parent) = cache_path.parent()
            && let Err(e) = tokio::fs::create_dir_all(parent).await
        {
            warn!(error = %e, "failed to create state dir for usage cache");
            return;
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

    /// Attach a SQLite backing store for credential analytics.
    pub fn with_db(self, db: Arc<NexusDb>) -> Self {
        // At this point there's only one Arc holder (before start()).
        let mut pool =
            Arc::try_unwrap(self.pool).expect("with_db must be called before pool() or start()");
        pool.db = Some(db);
        Self {
            pool: Arc::new(pool),
            healthy: self.healthy,
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

        // ── Auto-create credentials dir [2.1] ──────────────────────────
        if !creds_dir.is_dir() {
            info!(
                "Credential pool: creating {} (first run)",
                creds_dir.display()
            );
            tokio::fs::create_dir_all(&creds_dir)
                .await
                .with_context(|| format!("failed to create {}", creds_dir.display()))?;
        }

        let mut initial = scan_credential_files(&creds_dir).await;

        // ── Bootstrap import from CC [2.2] ─────────────────────────────
        // If pool is empty and ~/.claude/.credentials.json is a real file
        // (not already a managed symlink), import it into the pool.
        if initial.is_empty() {
            let cc_creds = paths::claude_credentials_path();
            if cc_creds.is_file() && !is_managed_symlink(&cc_creds, &creds_dir) {
                match bootstrap_import_credential(&cc_creds, &creds_dir).await {
                    Ok(acct) => {
                        info!(
                            account = %acct.name,
                            "Bootstrapped credential from CC .credentials.json"
                        );
                        initial.push(acct);
                    }
                    Err(e) => {
                        warn!(error = %e, "Failed to bootstrap credential from CC");
                    }
                }
            }
        }

        // ── Passthrough [2.4] ──────────────────────────────────────────
        // Only passthrough when dir exists, is empty, AND no CC credential detected.
        if initial.is_empty() {
            info!(
                "Credential pool passthrough: {} is empty and no CC credential detected",
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

        // [4.3] Load cached usage from DB first, fall back to disk cache.
        let db_polls: Vec<CredentialPollRecord> = self
            .pool
            .db
            .as_ref()
            .and_then(|db| match db.latest_credential_polls() {
                Ok(polls) if !polls.is_empty() => {
                    info!(
                        "Loaded {} latest credential polls from DB",
                        polls.len()
                    );
                    Some(polls)
                }
                Ok(_) => None,
                Err(e) => {
                    warn!(error = %e, "failed to load credential polls from DB");
                    None
                }
            })
            .unwrap_or_default();

        let cache_path = usage_cache_path();
        let cached = if db_polls.is_empty() {
            load_fresh_cache(&cache_path)
        } else {
            None
        };

        // Merge usage data into accounts (prefer DB polls over disk cache).
        let accounts: Vec<CredentialAccount> = initial
            .into_iter()
            .map(|mut acct| {
                // Try DB polls first.
                if let Some(poll) = db_polls.iter().find(|p| p.account == acct.name) {
                    let five_hour_resets = poll
                        .five_hour_resets_at
                        .as_ref()
                        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
                        .unwrap_or_else(Utc::now);
                    let seven_day_resets = poll
                        .seven_day_resets_at
                        .as_ref()
                        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
                        .unwrap_or_else(Utc::now);
                    let last_polled = poll
                        .timestamp
                        .parse::<DateTime<Utc>>()
                        .unwrap_or_else(|_| Utc::now());
                    acct.usage = Some(AccountUsage {
                        five_hour: nexus_core::credentials::UsageWindow {
                            utilization: poll.five_hour_utilization.unwrap_or(0.0) as f32,
                            resets_at: five_hour_resets,
                        },
                        seven_day: nexus_core::credentials::UsageWindow {
                            utilization: poll.seven_day_utilization.unwrap_or(0.0) as f32,
                            resets_at: seven_day_resets,
                        },
                    });
                    acct.last_polled = Some(last_polled);
                } else if let Some(ref cache) = cached
                    && let Some(cu) = cache.accounts.get(&acct.name)
                {
                    acct.usage = Some(AccountUsage {
                        five_hour: cu.five_hour.clone(),
                        seven_day: cu.seven_day.clone(),
                    });
                    acct.last_polled = Some(cu.last_polled);
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
    match parse_credential_file(path).await {
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
        if let Some(last) = self.last_event.get(path)
            && now.duration_since(*last) < self.window
        {
            self.last_event.insert(path.to_path_buf(), now);
            return false;
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
async fn parse_credential_file(path: &Path) -> Result<CredentialAccount> {
    let content = tokio::fs::read_to_string(path)
        .await
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
async fn scan_credential_files(dir: &Path) -> Vec<CredentialAccount> {
    let mut dir_entries = match tokio::fs::read_dir(dir).await {
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
    while let Ok(Some(entry)) = dir_entries.next_entry().await {
        let path = entry.path();
        let is_file = entry
            .file_type()
            .await
            .map(|ft| ft.is_file())
            .unwrap_or(false);
        if is_file && is_credential_json(&path) {
            match parse_credential_file(&path).await {
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

/// Import a CC credential file into the pool directory.
///
/// Copies the file to `pool_dir/acct-{fingerprint}.json`, then converts
/// the original path to a symlink pointing at the copy.
async fn bootstrap_import_credential(
    cc_creds_path: &Path,
    pool_dir: &Path,
) -> Result<CredentialAccount> {
    let content = tokio::fs::read_to_string(cc_creds_path)
        .await
        .with_context(|| format!("failed to read {}", cc_creds_path.display()))?;

    let cred: CredentialFile = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", cc_creds_path.display()))?;

    let fingerprint = fingerprint_token(&cred.claude_ai_oauth.access_token);
    let pool_filename = format!("acct-{}.json", fingerprint);
    let pool_path = pool_dir.join(&pool_filename);

    // Copy to pool dir.
    tokio::fs::write(&pool_path, &content)
        .await
        .with_context(|| format!("failed to write {}", pool_path.display()))?;

    // Convert .credentials.json to symlink pointing at the pool copy.
    tokio::fs::remove_file(cc_creds_path).await.ok();
    tokio::fs::symlink(&pool_path, cc_creds_path)
        .await
        .with_context(|| {
            format!(
                "failed to symlink {} -> {}",
                cc_creds_path.display(),
                pool_path.display()
            )
        })?;

    info!(
        "Converted {} to symlink -> {}",
        cc_creds_path.display(),
        pool_path.display()
    );

    parse_credential_file(&pool_path).await
}

/// Import a credential file from CC into the pool directory (watcher bridge).
///
/// Called when the credential watcher detects a change to `.credentials.json`.
/// If it is already a managed symlink, does nothing. Otherwise copies to pool dir.
pub async fn import_credential_to_pool(
    cc_creds_path: &Path,
    pool_dir: &Path,
) -> Result<Option<CredentialAccount>> {
    if is_managed_symlink(cc_creds_path, pool_dir) {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(cc_creds_path)
        .await
        .with_context(|| format!("failed to read {}", cc_creds_path.display()))?;

    let cred: CredentialFile = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", cc_creds_path.display()))?;

    let fingerprint = fingerprint_token(&cred.claude_ai_oauth.access_token);
    let pool_filename = format!("acct-{}.json", fingerprint);
    let pool_path = pool_dir.join(&pool_filename);

    // Write (or overwrite) the pool file — handles token refresh.
    tokio::fs::write(&pool_path, &content)
        .await
        .with_context(|| format!("failed to write {}", pool_path.display()))?;

    info!(
        fingerprint = %fingerprint,
        "Imported credential to pool: {}",
        pool_path.display()
    );

    Ok(Some(parse_credential_file(&pool_path).await?))
}

/// Try to discover a human-readable name for a credential account by querying the API.
///
/// On success, renames the pool file from `acct-{fingerprint}.json` to `acct-{name}.json`.
/// Falls back silently to fingerprint name if the API call fails.
pub async fn try_discover_account_name(
    pool: &CredentialPool,
    acct: &CredentialAccount,
    _pool_dir: &Path,
) {
    // Try to get account info via the usage API — if it works, the account is valid
    // but we don't have a profile endpoint, so we use the token fingerprint.
    // This is a placeholder for future name discovery via a profile endpoint.
    let client = &pool.http_client;
    match query_usage(client, &acct.access_token).await {
        Ok(_usage) => {
            // Usage query succeeded — account is valid but we don't have a name.
            // Future: call a profile endpoint to get the account display name.
            debug!(account = %acct.name, "Account validated via usage API (no name endpoint available)");
        }
        Err(e) => {
            debug!(account = %acct.name, error = %e, "Name discovery failed, keeping fingerprint name");
        }
    }
}

/// Rename a credential file in the pool from one name to another.
///
/// Updates both the filesystem and the in-memory pool state.
#[allow(dead_code)]
pub async fn rename_pool_credential(
    pool: &CredentialPool,
    old_name: &str,
    new_name: &str,
    pool_dir: &Path,
) -> Result<()> {
    let sanitized = sanitize_account_name(new_name);
    if sanitized.is_empty() || sanitized == old_name {
        return Ok(());
    }

    let old_path = pool_dir.join(format!("acct-{}.json", old_name));
    let new_path = pool_dir.join(format!("acct-{}.json", sanitized));

    if old_path.exists() {
        tokio::fs::rename(&old_path, &new_path)
            .await
            .with_context(|| {
                format!(
                    "failed to rename {} -> {}",
                    old_path.display(),
                    new_path.display()
                )
            })?;

        // Update in-memory state.
        let mut accounts = pool.accounts.write().await;
        if let Some(acct) = accounts.iter_mut().find(|a| a.name == old_name) {
            acct.name = sanitized.clone();
            acct.path = new_path;
        }

        info!(old = %old_name, new = %sanitized, "Renamed credential in pool");
    }

    Ok(())
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

    #[tokio::test]
    async fn test_parse_credential_file() {
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

        let acct = parse_credential_file(&path).await.unwrap();
        assert_eq!(acct.name, "personal");
        assert_eq!(acct.access_token, "tok-abc123");
        assert!(acct.expires_at.is_some());
        assert!(acct.usage.is_none());
    }

    #[tokio::test]
    async fn test_parse_credential_file_no_expiry() {
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

        let acct = parse_credential_file(&path).await.unwrap();
        assert_eq!(acct.name, "work");
        assert!(acct.expires_at.is_none());
    }

    #[tokio::test]
    async fn test_parse_credential_file_bad_json() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("bad.json");
        fs::write(&path, "not json").unwrap();
        assert!(parse_credential_file(&path).await.is_err());
    }

    #[tokio::test]
    async fn test_scan_credential_files() {
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

        let accounts = scan_credential_files(tmp.path()).await;
        assert_eq!(accounts.len(), 2);

        let names: Vec<&str> = accounts.iter().map(|a| a.name.as_str()).collect();
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
    }

    #[tokio::test]
    async fn test_scan_nonexistent_dir() {
        let accounts = scan_credential_files(Path::new("/tmp/nonexistent-nx-test-dir")).await;
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
