//! Record and update types for the Nexus database.

/// A row from the `specs` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpecRecord {
    pub id: String,
    pub project: String,
    pub name: String,
    pub status: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tasks_total: u32,
    pub tasks_done: u32,
    pub proposal_hash: Option<String>,
    pub discovered_at: String,
    pub read_at: Option<String>,
    pub approved_at: Option<String>,
    pub applied_at: Option<String>,
    pub archived_at: Option<String>,
    pub rejected_at: Option<String>,
    pub rejection_reason: Option<String>,
}

/// A row from the `sessions` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub pid: Option<i64>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_heartbeat: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub session_type: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub rate_limit_utilization: Option<f32>,
    pub rate_limit_type: Option<String>,
    pub tmux_target: Option<String>,
    pub cc_session_id: Option<String>,
    pub agent: Option<String>,
}

/// Partial update for a session (heartbeat, telemetry fields).
#[derive(Debug, Clone, Default)]
pub struct SessionUpdate {
    pub last_heartbeat: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub rate_limit_utilization: Option<f32>,
    pub rate_limit_type: Option<String>,
}

/// A row from the `failures` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FailureRecord {
    pub timestamp: String,
    pub tool_name: String,
    pub error_summary: Option<String>,
    pub project: Option<String>,
    pub session_id: Option<String>,
}

/// Query parameters for filtering failures.
#[derive(Debug, Clone, Default)]
pub struct FailureQuery {
    pub tool_name: Option<String>,
    pub project: Option<String>,
    pub since: Option<String>,
    pub limit: Option<u32>,
}

/// A row from the `events` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EventRecord {
    pub id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub actor: Option<String>,
    pub target: Option<String>,
    pub details: Option<String>,
}

/// Stats returned by `prune_old_records`.
#[derive(Debug)]
pub struct PruneStats {
    pub sessions_deleted: usize,
    pub failures_deleted: usize,
    pub events_deleted: usize,
    pub specs_deleted: usize,
    pub health_samples_deleted: usize,
    pub spec_snapshots_deleted: usize,
    pub credential_polls_deleted: usize,
    pub credential_swaps_deleted: usize,
    pub notifications_deleted: usize,
    pub cron_runs_deleted: usize,
    pub git_events_deleted: usize,
    pub lifecycle_deleted: usize,
}

/// A row from the `health_samples` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HealthSampleRecord {
    pub timestamp: String,
    pub cpu_percent: Option<f64>,
    pub memory_used_gb: Option<f64>,
    pub memory_total_gb: Option<f64>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub load1: Option<f64>,
    pub load5: Option<f64>,
    pub load15: Option<f64>,
    pub uptime_seconds: Option<i64>,
}

/// A row from the `spec_snapshots` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpecSnapshotRecord {
    pub timestamp: String,
    pub project: String,
    pub spec_name: String,
    pub completed_tasks: Option<u32>,
    pub total_tasks: Option<u32>,
}

/// A row from the `credential_polls` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CredentialPollRecord {
    pub timestamp: String,
    pub account: String,
    pub five_hour_utilization: Option<f64>,
    pub seven_day_utilization: Option<f64>,
    pub five_hour_resets_at: Option<String>,
    pub seven_day_resets_at: Option<String>,
}

/// A row from the `credential_swaps` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CredentialSwapRecord {
    pub timestamp: String,
    pub from_account: String,
    pub to_account: String,
    pub trigger_session_id: Option<String>,
}

/// A row from the `notifications` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationRecord {
    pub timestamp: String,
    pub message: String,
    pub message_type: Option<String>,
    pub project: Option<String>,
    pub channels: Option<String>,
    pub delivered: bool,
    pub suppressed: bool,
}

/// A row from the `cron_runs` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CronRunRecord {
    pub id: Option<i64>,
    pub timestamp: String,
    pub job: String,
    pub status: String,
    pub details: Option<String>,
    pub duration_ms: Option<i64>,
}

/// A row from the `git_events` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GitEventRecord {
    pub id: Option<i64>,
    pub timestamp: String,
    pub project: String,
    pub event_type: String,
    pub old_ref: Option<String>,
    pub new_ref: Option<String>,
}

/// A row from the `agent_lifecycle` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentLifecycleRecord {
    pub id: Option<i64>,
    pub timestamp: String,
    pub event_type: String,
    pub version: Option<String>,
    pub uptime_seconds: Option<i64>,
    pub reason: Option<String>,
}
