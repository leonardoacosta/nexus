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
    pub cc_session_id: Option<String>,
    /// Tmux pane identifier for bidirectional routing (e.g. "main:0.1").
    /// Populated from the `$TMUX_PANE` environment variable captured at
    /// session start via the telemetry hook.
    pub tmux_target: Option<String>,

    // Telemetry fields (populated from CC stream-json events).
    pub rate_limit_utilization: Option<f32>,
    pub rate_limit_type: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub model: Option<String>,

    /// Whether this session is ad-hoc, managed, or part of a pool.
    #[serde(default)]
    pub session_type: SessionType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionType {
    #[default]
    AdHoc,
    Managed,
    Pooled,
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
    /// Session gracefully ended
    Ended,
}

impl std::fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionStatus::Active => write!(f, "active"),
            SessionStatus::Idle => write!(f, "idle"),
            SessionStatus::Stale => write!(f, "stale"),
            SessionStatus::Errored => write!(f, "errored"),
            SessionStatus::Ended => write!(f, "ended"),
        }
    }
}

impl std::fmt::Display for SessionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionType::AdHoc => write!(f, "ad_hoc"),
            SessionType::Managed => write!(f, "managed"),
            SessionType::Pooled => write!(f, "pooled"),
        }
    }
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
            cc_session_id: None,
            tmux_target: None,
            rate_limit_utilization: None,
            rate_limit_type: None,
            total_cost_usd: None,
            model: None,
            session_type: SessionType::AdHoc,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_type_default_is_ad_hoc() {
        assert_eq!(SessionType::default(), SessionType::AdHoc);
    }

    #[test]
    fn session_type_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&SessionType::AdHoc).unwrap(),
            r#""ad_hoc""#
        );
        assert_eq!(
            serde_json::to_string(&SessionType::Managed).unwrap(),
            r#""managed""#
        );
        assert_eq!(
            serde_json::to_string(&SessionType::Pooled).unwrap(),
            r#""pooled""#
        );
    }

    #[test]
    fn session_type_deserializes_snake_case() {
        let v: SessionType = serde_json::from_str(r#""ad_hoc""#).unwrap();
        assert_eq!(v, SessionType::AdHoc);
        let v: SessionType = serde_json::from_str(r#""pooled""#).unwrap();
        assert_eq!(v, SessionType::Pooled);
    }

    #[test]
    fn new_session_has_ad_hoc_type_by_default() {
        let s = Session::new(1234, "/tmp".into());
        assert_eq!(s.session_type, SessionType::AdHoc);
    }

    #[test]
    fn session_type_field_defaults_on_missing_json() {
        // Deserializing a Session without `session_type` field should default to AdHoc.
        let json = r#"{
            "id": "abc",
            "pid": 1,
            "project": null,
            "cwd": "/tmp",
            "branch": null,
            "started_at": "2024-01-01T00:00:00Z",
            "last_heartbeat": "2024-01-01T00:00:00Z",
            "status": "active",
            "spec": null,
            "command": null,
            "agent": null,
            "tmux_session": null,
            "cc_session_id": null,
            "tmux_target": null,
            "rate_limit_utilization": null,
            "rate_limit_type": null,
            "total_cost_usd": null,
            "model": null
        }"#;
        let s: Session = serde_json::from_str(json).unwrap();
        assert_eq!(s.session_type, SessionType::AdHoc);
    }
}
