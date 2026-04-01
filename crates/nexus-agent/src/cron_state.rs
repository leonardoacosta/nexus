//! Shared cron state for nexus-agent cron jobs.
//!
//! `CronState` is an `Arc<RwLock<...>>` shared between the CronService
//! (which populates it) and the HTTP `/cron` handler (which reads it).
//!
//! Cron job results are persisted to SQLite (see `NexusDb::insert_cron_run`).
//! This module only maintains in-memory state for fast HTTP responses.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

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
