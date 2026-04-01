//! Git event CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::GitEventRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert a git event record.
    pub fn insert_git_event(&self, event: &GitEventRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO git_events (timestamp, project, event_type, old_ref, new_ref)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    event.timestamp,
                    event.project,
                    event.event_type,
                    event.old_ref,
                    event.new_ref,
                ],
            )?;
            Ok(())
        })
    }

    /// Query git events with optional project filter, ordered by timestamp descending.
    pub fn query_git_events(
        &self,
        project: Option<&str>,
        limit: u32,
    ) -> Result<Vec<GitEventRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match project {
                Some(p) => (
                    "SELECT id, timestamp, project, event_type, old_ref, new_ref
                     FROM git_events WHERE project = ?1
                     ORDER BY timestamp DESC LIMIT ?2"
                        .to_string(),
                    vec![p.to_string()],
                ),
                None => (
                    "SELECT id, timestamp, project, event_type, old_ref, new_ref
                     FROM git_events
                     ORDER BY timestamp DESC LIMIT ?1"
                        .to_string(),
                    vec![],
                ),
            };

            let mut stmt = conn.prepare(&sql)?;
            let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = bind_values
                .iter()
                .map(|v| Box::new(v.clone()) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            all_params.push(Box::new(limit));
            let rows = stmt.query_map(
                rusqlite::params_from_iter(all_params.iter().map(|p| p.as_ref())),
                |row| {
                    Ok(GitEventRecord {
                        id: row.get(0)?,
                        timestamp: row.get(1)?,
                        project: row.get(2)?,
                        event_type: row.get(3)?,
                        old_ref: row.get(4)?,
                        new_ref: row.get(5)?,
                    })
                },
            )?;

            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }
}
