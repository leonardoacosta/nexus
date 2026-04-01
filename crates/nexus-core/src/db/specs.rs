//! Spec CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::helpers::OptionalExt;
use super::types::SpecRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert or update a spec record. On conflict (same id), updates all fields
    /// except `discovered_at`.
    pub fn upsert_spec(&self, spec: &SpecRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO specs (
                    id, project, name, status, title, summary,
                    tasks_total, tasks_done, proposal_hash,
                    discovered_at, read_at, approved_at, applied_at, archived_at,
                    rejected_at, rejection_reason
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    title = excluded.title,
                    summary = excluded.summary,
                    tasks_total = excluded.tasks_total,
                    tasks_done = excluded.tasks_done,
                    proposal_hash = excluded.proposal_hash,
                    read_at = excluded.read_at,
                    approved_at = excluded.approved_at,
                    applied_at = excluded.applied_at,
                    archived_at = excluded.archived_at,
                    rejected_at = excluded.rejected_at,
                    rejection_reason = excluded.rejection_reason",
                params![
                    spec.id,
                    spec.project,
                    spec.name,
                    spec.status,
                    spec.title,
                    spec.summary,
                    spec.tasks_total,
                    spec.tasks_done,
                    spec.proposal_hash,
                    spec.discovered_at,
                    spec.read_at,
                    spec.approved_at,
                    spec.applied_at,
                    spec.archived_at,
                    spec.rejected_at,
                    spec.rejection_reason,
                ],
            )?;
            Ok(())
        })
    }

    /// Retrieve a single spec by project code and spec name.
    pub fn get_spec(&self, project: &str, name: &str) -> Result<Option<SpecRecord>> {
        self.read(|conn| {
            let id = format!("{project}/{name}");
            let mut stmt = conn.prepare(
                "SELECT id, project, name, status, title, summary,
                        tasks_total, tasks_done, proposal_hash,
                        discovered_at, read_at, approved_at, applied_at, archived_at,
                        rejected_at, rejection_reason
                 FROM specs WHERE id = ?1",
            )?;
            let result = stmt
                .query_row(params![id], |row| {
                    Ok(SpecRecord {
                        id: row.get(0)?,
                        project: row.get(1)?,
                        name: row.get(2)?,
                        status: row.get(3)?,
                        title: row.get(4)?,
                        summary: row.get(5)?,
                        tasks_total: row.get(6)?,
                        tasks_done: row.get(7)?,
                        proposal_hash: row.get(8)?,
                        discovered_at: row.get(9)?,
                        read_at: row.get(10)?,
                        approved_at: row.get(11)?,
                        applied_at: row.get(12)?,
                        archived_at: row.get(13)?,
                        rejected_at: row.get(14)?,
                        rejection_reason: row.get(15)?,
                    })
                })
                .optional()?;
            Ok(result)
        })
    }

    /// List specs, optionally filtered by status values.
    pub fn list_specs(&self, status_filter: Option<&[&str]>) -> Result<Vec<SpecRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match status_filter {
                Some(statuses) if !statuses.is_empty() => {
                    let placeholders: Vec<String> =
                        (1..=statuses.len()).map(|i| format!("?{i}")).collect();
                    let sql = format!(
                        "SELECT id, project, name, status, title, summary,
                                tasks_total, tasks_done, proposal_hash,
                                discovered_at, read_at, approved_at, applied_at, archived_at,
                                rejected_at, rejection_reason
                         FROM specs WHERE status IN ({})
                         ORDER BY discovered_at DESC",
                        placeholders.join(", ")
                    );
                    let values: Vec<String> = statuses.iter().map(|s| s.to_string()).collect();
                    (sql, values)
                }
                _ => {
                    let sql = "SELECT id, project, name, status, title, summary,
                                      tasks_total, tasks_done, proposal_hash,
                                      discovered_at, read_at, approved_at, applied_at, archived_at,
                                      rejected_at, rejection_reason
                               FROM specs ORDER BY discovered_at DESC"
                        .to_string();
                    (sql, vec![])
                }
            };

            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> = bind_values
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();

            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(SpecRecord {
                    id: row.get(0)?,
                    project: row.get(1)?,
                    name: row.get(2)?,
                    status: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    tasks_total: row.get(6)?,
                    tasks_done: row.get(7)?,
                    proposal_hash: row.get(8)?,
                    discovered_at: row.get(9)?,
                    read_at: row.get(10)?,
                    approved_at: row.get(11)?,
                    applied_at: row.get(12)?,
                    archived_at: row.get(13)?,
                    rejected_at: row.get(14)?,
                    rejection_reason: row.get(15)?,
                })
            })?;

            let mut specs = Vec::new();
            for row in rows {
                specs.push(row?);
            }
            Ok(specs)
        })
    }

    /// Update only the status column (and associated timestamp) of a spec.
    pub fn update_spec_status(&self, project: &str, name: &str, status: &str) -> Result<()> {
        self.write(|conn| {
            let id = format!("{project}/{name}");
            let now = chrono::Utc::now().to_rfc3339();

            // Update the status and the corresponding timestamp column.
            let timestamp_col = match status {
                "read" => Some("read_at"),
                "approved" => Some("approved_at"),
                "applied" => Some("applied_at"),
                "archived" => Some("archived_at"),
                "rejected" => Some("rejected_at"),
                _ => None,
            };

            if let Some(col) = timestamp_col {
                let sql = format!("UPDATE specs SET status = ?1, {col} = ?2 WHERE id = ?3");
                conn.execute(&sql, params![status, now, id])?;
            } else {
                conn.execute(
                    "UPDATE specs SET status = ?1 WHERE id = ?2",
                    params![status, id],
                )?;
            }

            Ok(())
        })
    }

    /// Update task progress for a spec.
    pub fn update_spec_tasks(
        &self,
        project: &str,
        name: &str,
        done: u32,
        total: u32,
    ) -> Result<()> {
        self.write(|conn| {
            let id = format!("{project}/{name}");
            conn.execute(
                "UPDATE specs SET tasks_done = ?1, tasks_total = ?2 WHERE id = ?3",
                params![done, total, id],
            )?;
            Ok(())
        })
    }
}
