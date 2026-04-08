use chrono::{DateTime, Utc};

use super::agent::{ActivityStatus, SyncStatus};

// ---------------------------------------------------------------------------
// Project summary for projects screen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProjectSummary {
    pub name: String,
    pub total: usize,
    pub active: usize,
    pub idle: usize,
    pub stale: usize,
    pub errored: usize,
    pub agents: Vec<String>,
    pub activity_status: ActivityStatus,
    pub last_activity: Option<DateTime<Utc>>,
    pub sync_status: SyncStatus,
    pub commits_behind: Option<i32>,
    pub git_branch: Option<String>,
}

// ---------------------------------------------------------------------------
// Enriched project detail (from ListProjects enriched response)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProjectDetail {
    pub sync_status: SyncStatus,
    pub commits_behind: Option<i32>,
    pub git_branch: Option<String>,
    /// Filesystem path to the project root, sourced from the agent.
    pub path: Option<String>,
}
