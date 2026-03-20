use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A Claude Code session running on a specific machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub pid: u32,
    pub project: Option<String>,
    pub cwd: String,
    pub branch: Option<String>,
    pub started_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
    pub status: SessionStatus,
    pub spec: Option<String>,
    pub command: Option<String>,
    pub agent: Option<String>,
    pub tmux_session: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Heartbeat < 60s, agent executing
    Active,
    /// Heartbeat < 300s, waiting for input
    Idle,
    /// Heartbeat > 300s
    Stale,
    /// Process dead or disconnected
    Errored,
}

impl Session {
    pub fn new(pid: u32, cwd: String) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            pid,
            project: None,
            cwd,
            branch: None,
            started_at: now,
            last_heartbeat: now,
            status: SessionStatus::Active,
            spec: None,
            command: None,
            agent: None,
            tmux_session: None,
        }
    }

    /// Compute status from heartbeat age.
    pub fn compute_status(&mut self) {
        let elapsed = Utc::now()
            .signed_duration_since(self.last_heartbeat)
            .num_seconds();
        self.status = match elapsed {
            0..=60 => SessionStatus::Active,
            61..=300 => SessionStatus::Idle,
            _ => SessionStatus::Stale,
        };
    }

    pub fn idle_seconds(&self) -> i64 {
        Utc::now()
            .signed_duration_since(self.last_heartbeat)
            .num_seconds()
    }
}
