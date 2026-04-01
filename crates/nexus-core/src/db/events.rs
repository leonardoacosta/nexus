//! Event logging operations.

use anyhow::Result;
use rusqlite::params;

use super::types::EventRecord;
use super::NexusDb;

impl NexusDb {
    /// Log an audit event.
    pub fn log_event(
        &self,
        event_type: &str,
        actor: &str,
        target: &str,
        details: Option<&str>,
    ) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO events (timestamp, event_type, actor, target, details)
                 VALUES (datetime('now'), ?1, ?2, ?3, ?4)",
                params![event_type, actor, target, details],
            )?;
            Ok(())
        })
    }

    /// Query recent events with optional type and target filters.
    pub fn query_events(
        &self,
        event_type: Option<&str>,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<EventRecord>> {
        self.read(|conn| {
            let mut conditions: Vec<String> = Vec::new();
            let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            let mut idx = 1u32;

            if let Some(et) = event_type {
                conditions.push(format!("event_type = ?{idx}"));
                bind_values.push(Box::new(et.to_string()));
                idx += 1;
            }
            if let Some(t) = target {
                conditions.push(format!("target = ?{idx}"));
                bind_values.push(Box::new(t.to_string()));
                idx += 1;
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conditions.join(" AND "))
            };

            let sql = format!(
                "SELECT id, timestamp, event_type, actor, target, details
                 FROM events {where_clause}
                 ORDER BY timestamp DESC LIMIT ?{idx}"
            );
            bind_values.push(Box::new(limit as i64));

            let params: Vec<&dyn rusqlite::types::ToSql> =
                bind_values.iter().map(|b| b.as_ref()).collect();

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(EventRecord {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    event_type: row.get(2)?,
                    actor: row.get(3)?,
                    target: row.get(4)?,
                    details: row.get(5)?,
                })
            })?;

            let mut events = Vec::new();
            for row in rows {
                events.push(row?);
            }
            Ok(events)
        })
    }
}
