//! Agent lifecycle CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::AgentLifecycleRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert an agent lifecycle event.
    pub fn insert_lifecycle_event(&self, event: &AgentLifecycleRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO agent_lifecycle (timestamp, event_type, version, uptime_seconds, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    event.timestamp,
                    event.event_type,
                    event.version,
                    event.uptime_seconds,
                    event.reason,
                ],
            )?;
            Ok(())
        })
    }

    /// Query agent lifecycle events, ordered by timestamp descending.
    pub fn query_lifecycle_events(&self, limit: u32) -> Result<Vec<AgentLifecycleRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, timestamp, event_type, version, uptime_seconds, reason
                 FROM agent_lifecycle ORDER BY timestamp DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], |row| {
                Ok(AgentLifecycleRecord {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    event_type: row.get(2)?,
                    version: row.get(3)?,
                    uptime_seconds: row.get(4)?,
                    reason: row.get(5)?,
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
