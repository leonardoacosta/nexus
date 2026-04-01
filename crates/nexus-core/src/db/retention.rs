//! Retention cleanup operations.

use anyhow::Result;
use rusqlite::params;

use super::types::PruneStats;
use super::NexusDb;

impl NexusDb {
    /// Prune old records according to retention policy.
    ///
    /// - Sessions, failures, events: `session_days` (typically 30).
    /// - Archived specs: `spec_archive_days` (typically 90).
    pub fn prune_old_records(
        &self,
        session_days: i64,
        spec_archive_days: i64,
    ) -> Result<PruneStats> {
        self.write(|conn| {
            let sessions_deleted = conn.execute(
                "DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let failures_deleted = conn.execute(
                "DELETE FROM failures WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let events_deleted = conn.execute(
                "DELETE FROM events WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let specs_deleted = conn.execute(
                "DELETE FROM specs WHERE status = 'archived' AND archived_at < datetime('now', ?1)",
                params![format!("-{spec_archive_days} days")],
            )?;

            // V2 analytics tables — 30-day retention.
            let health_samples_deleted = conn.execute(
                "DELETE FROM health_samples WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let spec_snapshots_deleted = conn.execute(
                "DELETE FROM spec_snapshots WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let credential_polls_deleted = conn.execute(
                "DELETE FROM credential_polls WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let credential_swaps_deleted = conn.execute(
                "DELETE FROM credential_swaps WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let notifications_deleted = conn.execute(
                "DELETE FROM notifications WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            // V3 consolidation tables — 30-day retention.
            let cron_runs_deleted = conn.execute(
                "DELETE FROM cron_runs WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let git_events_deleted = conn.execute(
                "DELETE FROM git_events WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let lifecycle_deleted = conn.execute(
                "DELETE FROM agent_lifecycle WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            Ok(PruneStats {
                sessions_deleted,
                failures_deleted,
                events_deleted,
                specs_deleted,
                health_samples_deleted,
                spec_snapshots_deleted,
                credential_polls_deleted,
                credential_swaps_deleted,
                notifications_deleted,
                cron_runs_deleted,
                git_events_deleted,
                lifecycle_deleted,
            })
        })
    }
}
