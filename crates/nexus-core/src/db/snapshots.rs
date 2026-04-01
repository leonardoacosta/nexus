//! Spec snapshot CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::helpers::OptionalExt;
use super::types::SpecSnapshotRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert a spec snapshot (timeseries progress record).
    pub fn insert_spec_snapshot(&self, snapshot: &SpecSnapshotRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO spec_snapshots (timestamp, project, spec_name, completed_tasks, total_tasks)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    snapshot.timestamp,
                    snapshot.project,
                    snapshot.spec_name,
                    snapshot.completed_tasks,
                    snapshot.total_tasks,
                ],
            )?;
            Ok(())
        })
    }

    /// Get the latest snapshot for a specific spec (for dedup).
    pub fn latest_spec_snapshot(
        &self,
        project: &str,
        spec_name: &str,
    ) -> Result<Option<SpecSnapshotRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT timestamp, project, spec_name, completed_tasks, total_tasks
                 FROM spec_snapshots
                 WHERE project = ?1 AND spec_name = ?2
                 ORDER BY timestamp DESC LIMIT 1",
            )?;
            let result = stmt
                .query_row(params![project, spec_name], |row| {
                    Ok(SpecSnapshotRecord {
                        timestamp: row.get(0)?,
                        project: row.get(1)?,
                        spec_name: row.get(2)?,
                        completed_tasks: row.get(3)?,
                        total_tasks: row.get(4)?,
                    })
                })
                .optional()?;
            Ok(result)
        })
    }

    /// Query spec snapshots for a project, ordered by timestamp descending.
    pub fn query_spec_snapshots(
        &self,
        project: &str,
        limit: u32,
    ) -> Result<Vec<SpecSnapshotRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT timestamp, project, spec_name, completed_tasks, total_tasks
                 FROM spec_snapshots WHERE project = ?1
                 ORDER BY timestamp DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![project, limit], |row| {
                Ok(SpecSnapshotRecord {
                    timestamp: row.get(0)?,
                    project: row.get(1)?,
                    spec_name: row.get(2)?,
                    completed_tasks: row.get(3)?,
                    total_tasks: row.get(4)?,
                })
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }
}
