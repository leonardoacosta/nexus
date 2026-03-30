//! Shared cron state and structured logging for nexus-agent cron jobs.
//!
//! `CronState` is an `Arc<RwLock<...>>` shared between the CronService
//! (which populates it) and the HTTP `/cron` handler (which reads it).
//!
//! `CronLogger` appends JSONL entries to `~/.config/nexus/cron-log.jsonl`
//! with auto-rotation when the file exceeds 1 MB.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Maximum log file size before rotation (1 MB).
const MAX_LOG_SIZE: u64 = 1_048_576;

// ---------------------------------------------------------------------------
// CronState — shared between CronService and /cron handler
// ---------------------------------------------------------------------------

/// Per-job run state tracked in memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronJobState {
    pub schedule: String,
    pub last_run: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_log: Option<String>,
}

/// Shared cron state for all jobs.
#[derive(Debug, Clone)]
pub struct CronState {
    inner: Arc<RwLock<HashMap<String, CronJobState>>>,
}

impl CronState {
    /// Create a new CronState pre-populated with known job schedules.
    pub fn new() -> Self {
        let mut jobs = HashMap::new();
        jobs.insert(
            "maintain".to_string(),
            CronJobState {
                schedule: "daily @ 00:17".to_string(),
                last_run: None,
                last_status: None,
                last_log: None,
            },
        );
        jobs.insert(
            "drift".to_string(),
            CronJobState {
                schedule: "weekly @ Sun 09:00".to_string(),
                last_run: None,
                last_status: None,
                last_log: None,
            },
        );
        Self {
            inner: Arc::new(RwLock::new(jobs)),
        }
    }

    /// Update a job's last run state after execution.
    pub async fn record_run(&self, job: &str, status: &str, log_message: &str) {
        let mut state = self.inner.write().await;
        if let Some(entry) = state.get_mut(job) {
            entry.last_run = Some(Utc::now());
            entry.last_status = Some(status.to_string());
            entry.last_log = Some(log_message.to_string());
        }
    }

    /// Get a snapshot of all job states for the /cron endpoint.
    pub async fn snapshot(&self) -> HashMap<String, CronJobState> {
        self.inner.read().await.clone()
    }
}

// ---------------------------------------------------------------------------
// HTTP response types for GET /cron
// ---------------------------------------------------------------------------

/// JSON response for GET /cron.
#[derive(Debug, Serialize)]
pub struct CronResponse {
    pub jobs: HashMap<String, CronJobResponse>,
}

/// Per-job response within the /cron JSON.
#[derive(Debug, Serialize)]
pub struct CronJobResponse {
    pub schedule: String,
    pub last_run: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_log: Option<String>,
}

impl From<CronJobState> for CronJobResponse {
    fn from(state: CronJobState) -> Self {
        Self {
            schedule: state.schedule,
            last_run: state.last_run,
            last_status: state.last_status,
            last_log: state.last_log,
        }
    }
}

// ---------------------------------------------------------------------------
// CronLogger — structured JSONL logging with auto-rotation
// ---------------------------------------------------------------------------

/// Structured log entry for a maintain job run.
#[derive(Debug, Serialize, Deserialize)]
pub struct MaintainLogEntry {
    pub timestamp: DateTime<Utc>,
    pub job: String,
    pub status: String,
    pub items_pruned: u64,
    pub bytes_freed: u64,
    pub details: String,
}

/// Structured log entry for a drift job run.
#[derive(Debug, Serialize, Deserialize)]
pub struct DriftLogEntry {
    pub timestamp: DateTime<Utc>,
    pub job: String,
    pub status: String,
    pub findings: Vec<String>,
    pub severity: String,
}

/// Appends structured JSONL entries to the cron log file with auto-rotation.
pub struct CronLogger {
    log_path: PathBuf,
}

impl CronLogger {
    /// Create a new logger targeting `~/.config/nexus/cron-log.jsonl`.
    pub fn new() -> Option<Self> {
        let home = dirs::home_dir()?;
        let log_path = home.join(".config/nexus/cron-log.jsonl");
        Some(Self { log_path })
    }

    /// Create a logger with a custom path (useful for testing).
    #[cfg(test)]
    pub fn with_path(path: PathBuf) -> Self {
        Self { log_path: path }
    }

    /// Append a serializable entry as a single JSONL line.
    ///
    /// Auto-rotates the file if it exceeds 1 MB before writing.
    pub async fn append<T: Serialize>(&self, entry: &T) -> anyhow::Result<()> {
        // Ensure parent directory exists.
        if let Some(parent) = self.log_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Check file size and rotate if needed.
        self.maybe_rotate().await?;

        // Serialize to a single JSON line.
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');

        // Append to the log file.
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .await?;
        file.write_all(line.as_bytes()).await?;
        file.flush().await?;

        Ok(())
    }

    /// Log a maintain job run. Updates CronState and writes JSONL.
    pub async fn log_maintain(
        &self,
        state: &CronState,
        status: &str,
        items_pruned: u64,
        bytes_freed: u64,
        details: &str,
    ) -> anyhow::Result<()> {
        let log_message = if items_pruned > 0 {
            format!(
                "Pruned {} artifacts, freed {}",
                items_pruned,
                format_bytes(bytes_freed)
            )
        } else {
            "No artifacts to prune".to_string()
        };

        state.record_run("maintain", status, &log_message).await;

        let entry = MaintainLogEntry {
            timestamp: Utc::now(),
            job: "maintain".to_string(),
            status: status.to_string(),
            items_pruned,
            bytes_freed,
            details: details.to_string(),
        };

        self.append(&entry).await
    }

    /// Log a drift job run. Updates CronState and writes JSONL.
    pub async fn log_drift(
        &self,
        state: &CronState,
        status: &str,
        findings: Vec<String>,
        severity: &str,
    ) -> anyhow::Result<()> {
        let log_message = if findings.is_empty() {
            "No drift detected".to_string()
        } else {
            format!("{} findings: {}", findings.len(), findings.join(", "))
        };

        state.record_run("drift", status, &log_message).await;

        let entry = DriftLogEntry {
            timestamp: Utc::now(),
            job: "drift".to_string(),
            status: status.to_string(),
            findings,
            severity: severity.to_string(),
        };

        self.append(&entry).await
    }

    /// Rotate the log file if it exceeds MAX_LOG_SIZE.
    ///
    /// Renames `cron-log.jsonl` to `cron-log.jsonl.1` (overwriting any
    /// existing `.1` file), then the caller creates a fresh file.
    async fn maybe_rotate(&self) -> anyhow::Result<()> {
        match tokio::fs::metadata(&self.log_path).await {
            Ok(meta) if meta.len() > MAX_LOG_SIZE => {
                let rotated = self.log_path.with_extension("jsonl.1");
                tokio::fs::rename(&self.log_path, &rotated).await?;
                tracing::info!(
                    "cron log rotated: {} -> {} ({} bytes)",
                    self.log_path.display(),
                    rotated.display(),
                    meta.len()
                );
            }
            _ => {} // File doesn't exist or is under limit — nothing to do.
        }
        Ok(())
    }
}

/// Format bytes as a human-readable string (e.g., "48MB", "1.2GB").
fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;

    if bytes >= GB {
        format!("{:.1}GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{}MB", bytes / MB)
    } else if bytes >= KB {
        format!("{}KB", bytes / KB)
    } else {
        format!("{}B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_cron_state_initial_snapshot() {
        let state = CronState::new();
        let snapshot = state.snapshot().await;

        assert!(snapshot.contains_key("maintain"));
        assert!(snapshot.contains_key("drift"));

        let maintain = &snapshot["maintain"];
        assert_eq!(maintain.schedule, "daily @ 00:17");
        assert!(maintain.last_run.is_none());
        assert!(maintain.last_status.is_none());
        assert!(maintain.last_log.is_none());
    }

    #[tokio::test]
    async fn test_cron_state_record_run() {
        let state = CronState::new();
        state
            .record_run("maintain", "success", "Pruned 5 artifacts")
            .await;

        let snapshot = state.snapshot().await;
        let maintain = &snapshot["maintain"];
        assert!(maintain.last_run.is_some());
        assert_eq!(maintain.last_status.as_deref(), Some("success"));
        assert_eq!(maintain.last_log.as_deref(), Some("Pruned 5 artifacts"));
    }

    #[tokio::test]
    async fn test_cron_logger_append() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cron-log.jsonl");
        let logger = CronLogger::with_path(path.clone());

        let entry = MaintainLogEntry {
            timestamp: Utc::now(),
            job: "maintain".to_string(),
            status: "success".to_string(),
            items_pruned: 3,
            bytes_freed: 1024,
            details: "test".to_string(),
        };

        logger.append(&entry).await.unwrap();

        let contents = tokio::fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 1);

        let parsed: MaintainLogEntry = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(parsed.job, "maintain");
        assert_eq!(parsed.items_pruned, 3);
    }

    #[tokio::test]
    async fn test_cron_logger_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cron-log.jsonl");
        let logger = CronLogger::with_path(path.clone());

        // Write enough data to exceed 1 MB.
        let big_entry = MaintainLogEntry {
            timestamp: Utc::now(),
            job: "maintain".to_string(),
            status: "success".to_string(),
            items_pruned: 0,
            bytes_freed: 0,
            details: "x".repeat(10_000),
        };

        for _ in 0..120 {
            logger.append(&big_entry).await.unwrap();
        }

        // The file should have been rotated.
        let rotated = path.with_extension("jsonl.1");
        assert!(rotated.exists(), "rotated file should exist");

        // The current file should be smaller than MAX_LOG_SIZE.
        let meta = tokio::fs::metadata(&path).await.unwrap();
        assert!(
            meta.len() < MAX_LOG_SIZE,
            "current file should be under 1MB after rotation"
        );
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(500), "500B");
        assert_eq!(format_bytes(2048), "2KB");
        assert_eq!(format_bytes(50_331_648), "48MB");
        assert_eq!(format_bytes(1_073_741_824), "1.0GB");
    }

    #[tokio::test]
    async fn test_cron_response_from_state() {
        let state = CronState::new();
        let snapshot = state.snapshot().await;

        let response = CronResponse {
            jobs: snapshot.into_iter().map(|(k, v)| (k, v.into())).collect(),
        };

        let json = serde_json::to_string_pretty(&response).unwrap();
        assert!(json.contains("maintain"));
        assert!(json.contains("drift"));
        assert!(json.contains("daily @ 00:17"));
    }
}
