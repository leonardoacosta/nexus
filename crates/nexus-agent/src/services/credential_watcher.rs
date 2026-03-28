//! Credential File Watcher Service
//!
//! Watches `~/.claude/` for auth-related file changes using the `notify` crate
//! (inotify on Linux, kqueue on macOS). Debounces changes with a 1-second window
//! and emits credential metadata events when auth files are created, modified, or removed.
//!
//! When credentials change, pushes metadata to configured menubar endpoints
//! (read from `~/.claude/scripts/notifications/config/servers.json`).
//!
//! Target files: credentials*, auth*, *.token, .credentials, oauth*

use crate::services::Service;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

// --- Types ---

/// Metadata about a credential file's current state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialMeta {
    /// Hostname this credential is associated with (derived from filename or content)
    pub hostname: String,
    /// Type of token (e.g., "oauth", "api_key", "session")
    pub token_type: String,
    /// Whether the credential file appears valid (non-empty, recently modified)
    pub valid: bool,
    /// When the credential expires (if determinable from file metadata)
    pub expires_at: Option<DateTime<Utc>>,
    /// When the credential was last refreshed (file modification time)
    pub refreshed_at: DateTime<Utc>,
    /// File size in bytes
    pub size_bytes: u64,
    /// Absolute path to the credential file
    pub path: PathBuf,
}

/// Events emitted when credential files change.
#[derive(Debug)]
enum CredentialEvent {
    /// A credential file was created or modified
    Changed(CredentialMeta),
    /// A credential file was removed
    Removed { path: PathBuf, hostname: String },
}

/// A menubar server endpoint from servers.json.
#[derive(Debug, Clone, Deserialize)]
struct MenubarServer {
    id: String,
    #[allow(dead_code)]
    label: String,
    url: String,
}

/// Payload pushed to menubar endpoints when credentials change.
#[derive(Debug, Serialize)]
struct CredentialPushPayload {
    hostname: String,
    token_type: String,
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    refreshed_at: String,
}

// --- Menubar Push ---

/// Path to the servers.json configuration file.
const SERVERS_JSON_PATH: &str = ".claude/scripts/notifications/config/servers.json";

/// HTTP request timeout for menubar pushes.
const PUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// Get the system hostname via libc::gethostname.
fn get_system_hostname() -> String {
    let mut buf = [0u8; 256];
    let ret = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if ret == 0 {
        let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..len]).to_string()
    } else {
        "unknown".to_string()
    }
}

/// Read menubar server endpoints from servers.json.
fn read_servers_config() -> Vec<MenubarServer> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let config_path = PathBuf::from(&home).join(SERVERS_JSON_PATH);

    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            debug!(
                "[credential-watcher] Cannot read servers.json at {}: {}",
                config_path.display(),
                e
            );
            return Vec::new();
        }
    };

    match serde_json::from_str::<Vec<MenubarServer>>(&content) {
        Ok(servers) => servers,
        Err(e) => {
            warn!("[credential-watcher] Failed to parse servers.json: {}", e);
            Vec::new()
        }
    }
}

/// Push credential metadata to all configured menubar endpoints.
///
/// Best-effort delivery: logs failures but does not retry.
async fn push_to_menubars(meta: &CredentialMeta) {
    let servers = read_servers_config();
    if servers.is_empty() {
        debug!("[credential-watcher] No menubar servers configured, skipping push");
        return;
    }

    let hostname = get_system_hostname();
    let payload = CredentialPushPayload {
        hostname,
        token_type: meta.token_type.clone(),
        valid: meta.valid,
        expires_at: meta
            .expires_at
            .map(|dt| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
        refreshed_at: meta.refreshed_at.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    };

    let client = reqwest::Client::builder()
        .timeout(PUSH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    for server in &servers {
        let url = format!("{}/credentials", server.url.trim_end_matches('/'));
        match client.post(&url).json(&payload).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    info!(
                        "[credential-watcher] Pushed credential update to {} ({}) — {}",
                        server.id,
                        url,
                        resp.status()
                    );
                } else {
                    warn!(
                        "[credential-watcher] Push to {} ({}) returned {}",
                        server.id,
                        url,
                        resp.status()
                    );
                }
            }
            Err(e) => {
                warn!(
                    "[credential-watcher] Failed to push to {} ({}): {}",
                    server.id, url, e
                );
            }
        }
    }
}

// --- File Matching ---

/// File name patterns that indicate auth/credential files.
const CREDENTIAL_PREFIXES: &[&str] = &["credentials", "auth", "oauth", ".credentials"];
const CREDENTIAL_EXTENSIONS: &[&str] = &["token"];

/// Check if a filename matches credential file patterns.
fn is_credential_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };

    let lower = file_name.to_lowercase();

    // Check prefix patterns: credentials*, auth*, oauth*, .credentials*
    for prefix in CREDENTIAL_PREFIXES {
        if lower.starts_with(prefix) {
            return true;
        }
    }

    // Check extension patterns: *.token
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let lower_ext = ext.to_lowercase();
        for cred_ext in CREDENTIAL_EXTENSIONS {
            if lower_ext == *cred_ext {
                return true;
            }
        }
    }

    false
}

// --- Metadata Extraction ---

/// Infer the token type from the filename.
fn infer_token_type(path: &Path) -> String {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return "unknown".to_string();
    };

    let lower = file_name.to_lowercase();

    if lower.starts_with("oauth") {
        "oauth".to_string()
    } else if lower.ends_with(".token") {
        "api_key".to_string()
    } else if lower.starts_with("auth") {
        "session".to_string()
    } else if lower.starts_with("credentials") || lower.starts_with(".credentials") {
        "credentials".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Derive a hostname identifier from the credential file.
/// Uses the filename stem as a logical identifier (e.g., "credentials.json" -> "default",
/// "auth-github.token" -> "github").
fn derive_hostname(path: &Path) -> String {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return "unknown".to_string();
    };

    let lower = file_name.to_lowercase();

    // Strip extensions first, then prefixes, to avoid prefix stripping consuming
    // part of the extension (e.g., "credentials.json" -> ".json" -> "json").
    let without_ext = lower
        .trim_end_matches(".json")
        .trim_end_matches(".token")
        .trim_end_matches(".txt")
        .trim_end_matches(".yaml")
        .trim_end_matches(".yml")
        .trim_end_matches(".toml");

    // Strip known prefixes to find a qualifier
    let stripped = without_ext
        .trim_start_matches(".credentials")
        .trim_start_matches("credentials")
        .trim_start_matches("oauth")
        .trim_start_matches("auth")
        .trim_start_matches(['-', '_', '.']);

    if stripped.is_empty() {
        "default".to_string()
    } else {
        stripped.to_string()
    }
}

/// Read file metadata and build a CredentialMeta.
fn read_credential_meta(path: &Path) -> Result<CredentialMeta> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("Failed to read metadata for {}", path.display()))?;

    let modified: DateTime<Utc> = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into();

    let size = metadata.len();

    // A credential is considered valid if:
    // - The file is non-empty
    // - It was modified within the last 90 days (stale credentials are suspect)
    let age = Utc::now().signed_duration_since(modified);
    let valid = size > 0 && age.num_days() < 90;

    Ok(CredentialMeta {
        hostname: derive_hostname(path),
        token_type: infer_token_type(path),
        valid,
        expires_at: None, // Would require parsing file content; metadata-only for now
        refreshed_at: modified,
        size_bytes: size,
        path: path.to_path_buf(),
    })
}

// --- Debounce Logic ---

/// Simple debounce tracker: records the last event time per path and only
/// fires when the debounce window has elapsed.
struct DebounceTracker {
    /// Last event timestamp per path
    last_event: HashMap<PathBuf, tokio::time::Instant>,
    /// Debounce window duration
    window: Duration,
}

impl DebounceTracker {
    fn new(window: Duration) -> Self {
        Self {
            last_event: HashMap::new(),
            window,
        }
    }

    /// Record an event for a path. Returns true if the event should be processed
    /// (i.e., the debounce window has elapsed since the last event for this path).
    fn should_process(&mut self, path: &Path) -> bool {
        let now = tokio::time::Instant::now();

        if let Some(last) = self.last_event.get(path) {
            if now.duration_since(*last) < self.window {
                // Within debounce window — suppress
                self.last_event.insert(path.to_path_buf(), now);
                return false;
            }
        }

        self.last_event.insert(path.to_path_buf(), now);
        true
    }

    /// Remove stale entries (paths not seen in 5x the debounce window).
    fn cleanup(&mut self) {
        let cutoff = tokio::time::Instant::now() - (self.window * 5);
        self.last_event.retain(|_, last| *last > cutoff);
    }
}

// --- Event Processing ---

/// Process a notify event into a credential event (if applicable).
fn process_notify_event(event: &Event, watch_dir: &Path) -> Option<(PathBuf, bool)> {
    // We only care about create, modify, and remove events
    let is_relevant = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );

    if !is_relevant {
        return None;
    }

    let is_remove = matches!(event.kind, EventKind::Remove(_));

    // Check each affected path
    for path in &event.paths {
        // Only process files directly in the watch directory (non-recursive)
        if path.parent() != Some(watch_dir) {
            continue;
        }

        if is_credential_file(path) {
            return Some((path.clone(), is_remove));
        }
    }

    None
}

/// Build a credential event from a file change.
fn build_credential_event(path: &Path, is_remove: bool) -> CredentialEvent {
    if is_remove {
        CredentialEvent::Removed {
            path: path.to_path_buf(),
            hostname: derive_hostname(path),
        }
    } else {
        match read_credential_meta(path) {
            Ok(meta) => CredentialEvent::Changed(meta),
            Err(e) => {
                // File may have been immediately deleted after creation
                debug!(
                    "Could not read credential metadata for {}: {}",
                    path.display(),
                    e
                );
                CredentialEvent::Removed {
                    path: path.to_path_buf(),
                    hostname: derive_hostname(path),
                }
            }
        }
    }
}

/// Log a credential event via tracing.
fn emit_event(event: &CredentialEvent) {
    match event {
        CredentialEvent::Changed(meta) => {
            info!(
                "[credential-watcher] {} changed: type={}, valid={}, size={}B, refreshed={}",
                meta.path.display(),
                meta.token_type,
                meta.valid,
                meta.size_bytes,
                meta.refreshed_at.format("%Y-%m-%dT%H:%M:%SZ"),
            );
        }
        CredentialEvent::Removed { path, hostname } => {
            warn!(
                "[credential-watcher] {} removed (hostname={})",
                path.display(),
                hostname,
            );
        }
    }
}

// --- Service Implementation ---

/// Credential file watcher daemon service.
///
/// Watches `~/.claude/` for auth-related file changes using inotify (Linux) or
/// kqueue (macOS) via the `notify` crate. Changes are debounced with a 1-second
/// window before emitting credential metadata events.
pub struct CredentialWatcherService {
    /// Debounce window in seconds
    debounce_secs: u64,
    /// Whether the service is healthy
    healthy: Arc<AtomicBool>,
}

impl CredentialWatcherService {
    /// Create a new credential watcher service with the given debounce window.
    pub fn new(debounce_secs: u64) -> Self {
        Self {
            debounce_secs,
            healthy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Get the credential metadata for a specific path.
    pub fn get_credential_meta(path: &Path) -> Result<CredentialMeta> {
        read_credential_meta(path)
    }
}

#[async_trait::async_trait]
impl Service for CredentialWatcherService {
    fn name(&self) -> &'static str {
        "credential-watcher"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let watch_dir = PathBuf::from(&home).join(".claude");

        if !watch_dir.is_dir() {
            warn!(
                "Watch directory does not exist: {}. Credential watcher will not start.",
                watch_dir.display()
            );
            return Ok(());
        }

        info!(
            "Credential-watcher service starting (debounce={}s, dir={})",
            self.debounce_secs,
            watch_dir.display()
        );

        // Scan for existing credential files on startup
        let existing = scan_existing_credentials(&watch_dir);
        if existing.is_empty() {
            info!("[credential-watcher] No existing credential files found");
        } else {
            info!(
                "[credential-watcher] Found {} existing credential file(s)",
                existing.len()
            );
            for meta in &existing {
                info!(
                    "[credential-watcher]   {} (type={}, valid={}, refreshed={})",
                    meta.path.file_name().unwrap_or_default().to_string_lossy(),
                    meta.token_type,
                    meta.valid,
                    meta.refreshed_at.format("%Y-%m-%dT%H:%M:%SZ"),
                );
            }
        }

        // Set up the notify watcher with a channel
        let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<Event>(100);

        let mut watcher = RecommendedWatcher::new(
            move |result: std::result::Result<Event, notify::Error>| {
                match result {
                    Ok(event) => {
                        // Send event to async channel (best-effort, don't block)
                        let _ = notify_tx.try_send(event);
                    }
                    Err(e) => {
                        error!("[credential-watcher] Watch error: {}", e);
                    }
                }
            },
            Config::default(),
        )
        .context("Failed to create file watcher")?;

        // Watch ~/.claude/ non-recursively
        watcher
            .watch(&watch_dir, RecursiveMode::NonRecursive)
            .with_context(|| format!("Failed to watch directory: {}", watch_dir.display()))?;

        info!(
            "[credential-watcher] Watching {} for credential file changes",
            watch_dir.display()
        );

        self.healthy.store(true, Ordering::SeqCst);

        let mut debounce = DebounceTracker::new(Duration::from_secs(self.debounce_secs));
        let mut cleanup_interval = tokio::time::interval(Duration::from_secs(60));

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Credential-watcher service shutting down");
                    break;
                }
                Some(event) = notify_rx.recv() => {
                    if let Some((path, is_remove)) = process_notify_event(&event, &watch_dir) {
                        if debounce.should_process(&path) {
                            let cred_event = build_credential_event(&path, is_remove);
                            emit_event(&cred_event);

                            // Push credential updates to menubar endpoints
                            if let CredentialEvent::Changed(ref meta) = cred_event {
                                push_to_menubars(meta).await;
                            }
                        } else {
                            debug!(
                                "[credential-watcher] Debounced event for {}",
                                path.display()
                            );
                        }
                    }
                }
                _ = cleanup_interval.tick() => {
                    debounce.cleanup();
                }
            }
        }

        // Drop the watcher explicitly before marking unhealthy
        drop(watcher);
        self.healthy.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn health_check(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }
}

/// Scan the watch directory for existing credential files and return their metadata.
fn scan_existing_credentials(watch_dir: &Path) -> Vec<CredentialMeta> {
    let mut results = Vec::new();

    let entries = match std::fs::read_dir(watch_dir) {
        Ok(entries) => entries,
        Err(e) => {
            warn!(
                "[credential-watcher] Failed to scan {}: {}",
                watch_dir.display(),
                e
            );
            return results;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_credential_file(&path) {
            match read_credential_meta(&path) {
                Ok(meta) => results.push(meta),
                Err(e) => {
                    debug!("[credential-watcher] Skipping {}: {}", path.display(), e);
                }
            }
        }
    }

    results
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_is_credential_file_matches() {
        // Prefix matches
        assert!(is_credential_file(Path::new("credentials.json")));
        assert!(is_credential_file(Path::new("credentials")));
        assert!(is_credential_file(Path::new("credentials-github")));
        assert!(is_credential_file(Path::new("auth.json")));
        assert!(is_credential_file(Path::new("auth-token")));
        assert!(is_credential_file(Path::new("oauth2-config.json")));
        assert!(is_credential_file(Path::new(".credentials")));
        assert!(is_credential_file(Path::new(".credentials.json")));

        // Extension matches
        assert!(is_credential_file(Path::new("api.token")));
        assert!(is_credential_file(Path::new("github.token")));
        assert!(is_credential_file(Path::new("session.Token")));
    }

    #[test]
    fn test_is_credential_file_rejects() {
        assert!(!is_credential_file(Path::new("config.json")));
        assert!(!is_credential_file(Path::new("settings.toml")));
        assert!(!is_credential_file(Path::new("CLAUDE.md")));
        assert!(!is_credential_file(Path::new("mcp.json")));
        assert!(!is_credential_file(Path::new("token-file.json"))); // "token" is not a prefix
        assert!(!is_credential_file(Path::new(".env")));
    }

    #[test]
    fn test_infer_token_type() {
        assert_eq!(infer_token_type(Path::new("oauth2-config.json")), "oauth");
        assert_eq!(infer_token_type(Path::new("github.token")), "api_key");
        assert_eq!(infer_token_type(Path::new("auth-session.json")), "session");
        assert_eq!(
            infer_token_type(Path::new("credentials.json")),
            "credentials"
        );
        assert_eq!(infer_token_type(Path::new(".credentials")), "credentials");
    }

    #[test]
    fn test_derive_hostname() {
        assert_eq!(derive_hostname(Path::new("credentials.json")), "default");
        assert_eq!(
            derive_hostname(Path::new("credentials-github.json")),
            "github"
        );
        assert_eq!(derive_hostname(Path::new("auth-homelab.token")), "homelab");
        assert_eq!(derive_hostname(Path::new("oauth2.json")), "2"); // edge case: "2" is the qualifier
        assert_eq!(derive_hostname(Path::new(".credentials")), "default");
    }

    #[test]
    fn test_read_credential_meta() {
        let tmp = TempDir::new().expect("create temp dir");
        let cred_path = tmp.path().join("credentials.json");
        fs::write(&cred_path, r#"{"token": "abc123"}"#).expect("write credential");

        let meta = read_credential_meta(&cred_path).expect("should read meta");
        assert_eq!(meta.hostname, "default");
        assert_eq!(meta.token_type, "credentials");
        assert!(meta.valid); // non-empty, just created
        assert!(meta.size_bytes > 0);
        assert_eq!(meta.path, cred_path);
    }

    #[test]
    fn test_read_credential_meta_empty_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let cred_path = tmp.path().join("auth.token");
        fs::write(&cred_path, "").expect("write empty credential");

        let meta = read_credential_meta(&cred_path).expect("should read meta");
        assert!(!meta.valid); // empty file is not valid
        assert_eq!(meta.size_bytes, 0);
    }

    #[test]
    fn test_scan_existing_credentials() {
        let tmp = TempDir::new().expect("create temp dir");

        // Create credential files
        fs::write(tmp.path().join("credentials.json"), "{}").expect("write");
        fs::write(tmp.path().join("auth.token"), "tok").expect("write");

        // Create non-credential files
        fs::write(tmp.path().join("config.json"), "{}").expect("write");
        fs::write(tmp.path().join("CLAUDE.md"), "# test").expect("write");

        let results = scan_existing_credentials(tmp.path());
        assert_eq!(results.len(), 2);

        let paths: Vec<String> = results
            .iter()
            .map(|m| m.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(paths.contains(&"credentials.json".to_string()));
        assert!(paths.contains(&"auth.token".to_string()));
    }

    #[test]
    fn test_process_notify_event_create() {
        let watch_dir = Path::new("/home/user/.claude");
        let event = Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/home/user/.claude/credentials.json")],
            attrs: Default::default(),
        };

        let result = process_notify_event(&event, watch_dir);
        assert!(result.is_some());
        let (path, is_remove) = result.unwrap();
        assert_eq!(path, PathBuf::from("/home/user/.claude/credentials.json"));
        assert!(!is_remove);
    }

    #[test]
    fn test_process_notify_event_remove() {
        let watch_dir = Path::new("/home/user/.claude");
        let event = Event {
            kind: EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![PathBuf::from("/home/user/.claude/auth.token")],
            attrs: Default::default(),
        };

        let result = process_notify_event(&event, watch_dir);
        assert!(result.is_some());
        let (_, is_remove) = result.unwrap();
        assert!(is_remove);
    }

    #[test]
    fn test_process_notify_event_ignores_non_credential() {
        let watch_dir = Path::new("/home/user/.claude");
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from("/home/user/.claude/config.json")],
            attrs: Default::default(),
        };

        assert!(process_notify_event(&event, watch_dir).is_none());
    }

    #[test]
    fn test_process_notify_event_ignores_subdirectory() {
        let watch_dir = Path::new("/home/user/.claude");
        let event = Event {
            kind: EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Content,
            )),
            paths: vec![PathBuf::from("/home/user/.claude/subdir/credentials.json")],
            attrs: Default::default(),
        };

        assert!(process_notify_event(&event, watch_dir).is_none());
    }

    #[test]
    fn test_debounce_tracker() {
        let mut tracker = DebounceTracker::new(Duration::from_secs(1));
        let path = Path::new("/tmp/credentials.json");

        // First event should always pass
        assert!(tracker.should_process(path));

        // Immediate second event should be suppressed (within 1s window)
        assert!(!tracker.should_process(path));
    }

    #[test]
    fn test_credential_watcher_service_new() {
        let service = CredentialWatcherService::new(1);
        assert_eq!(service.debounce_secs, 1);
        assert_eq!(service.name(), "credential-watcher");
    }

    #[tokio::test]
    async fn test_credential_watcher_health_check_before_start() {
        let service = CredentialWatcherService::new(1);
        assert!(!service.health_check().await);
    }

    #[tokio::test]
    async fn test_credential_watcher_shutdown() {
        let service = CredentialWatcherService::new(1);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move { service.start(shutdown_rx).await });

        // Give the service time to start
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Send shutdown
        let _ = shutdown_tx.send(()).await;

        // Should complete without error
        let result = tokio::time::timeout(Duration::from_secs(5), handle).await;
        assert!(result.is_ok(), "Service should shut down within timeout");
    }

    #[test]
    fn test_get_system_hostname_returns_nonempty() {
        let hostname = get_system_hostname();
        assert!(!hostname.is_empty());
        assert_ne!(hostname, "unknown");
    }

    #[test]
    fn test_menubar_server_deserialization() {
        let json = r#"[
            {"id": "homelab", "label": "Homelab", "url": "http://100.91.88.16:9999"},
            {"id": "cloudpc", "label": "Cloud PC", "url": "http://100.94.11.104:9999"}
        ]"#;

        let servers: Vec<MenubarServer> = serde_json::from_str(json).expect("parse servers");
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].id, "homelab");
        assert_eq!(servers[0].url, "http://100.91.88.16:9999");
        assert_eq!(servers[1].id, "cloudpc");
        assert_eq!(servers[1].url, "http://100.94.11.104:9999");
    }

    #[test]
    fn test_credential_push_payload_serialization() {
        let payload = CredentialPushPayload {
            hostname: "homelab".to_string(),
            token_type: "oauth".to_string(),
            valid: true,
            expires_at: Some("2026-03-20T14:00:00Z".to_string()),
            refreshed_at: "2026-03-19T14:00:00Z".to_string(),
        };

        let json = serde_json::to_value(&payload).expect("serialize payload");
        assert_eq!(json["hostname"], "homelab");
        assert_eq!(json["token_type"], "oauth");
        assert_eq!(json["valid"], true);
        assert_eq!(json["expires_at"], "2026-03-20T14:00:00Z");
        assert_eq!(json["refreshed_at"], "2026-03-19T14:00:00Z");
    }

    #[test]
    fn test_credential_push_payload_omits_none_expires() {
        let payload = CredentialPushPayload {
            hostname: "homelab".to_string(),
            token_type: "credentials".to_string(),
            valid: true,
            expires_at: None,
            refreshed_at: "2026-03-19T14:00:00Z".to_string(),
        };

        let json = serde_json::to_string(&payload).expect("serialize payload");
        assert!(!json.contains("expires_at"));
    }

    #[test]
    fn test_read_servers_config_missing_file() {
        // With HOME set to a temp dir that has no servers.json, should return empty
        let tmp = TempDir::new().expect("create temp dir");
        // SAFETY: single-threaded test, no other threads access HOME.
        unsafe {
            std::env::set_var("HOME", tmp.path());
        }
        let servers = read_servers_config();
        assert!(servers.is_empty());
        // Restore HOME
        let home = std::env::var("HOME").unwrap_or_default();
        // SAFETY: single-threaded test, no other threads access HOME.
        unsafe {
            std::env::set_var("HOME", home);
        }
    }
}
