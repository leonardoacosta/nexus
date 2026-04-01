//! Notification CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::NotificationRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert a notification record.
    pub fn insert_notification(&self, notification: &NotificationRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO notifications (
                    timestamp, message, message_type, project, channels, delivered, suppressed
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    notification.timestamp,
                    notification.message,
                    notification.message_type,
                    notification.project,
                    notification.channels,
                    notification.delivered as i32,
                    notification.suppressed as i32,
                ],
            )?;
            Ok(())
        })
    }

    /// Query notifications, ordered by timestamp descending.
    pub fn query_notifications(
        &self,
        project: Option<&str>,
        limit: u32,
    ) -> Result<Vec<NotificationRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match project {
                Some(p) => (
                    "SELECT timestamp, message, message_type, project, channels, delivered, suppressed
                     FROM notifications WHERE project = ?1
                     ORDER BY timestamp DESC LIMIT ?2"
                        .to_string(),
                    vec![p.to_string()],
                ),
                None => (
                    "SELECT timestamp, message, message_type, project, channels, delivered, suppressed
                     FROM notifications
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
                    Ok(NotificationRecord {
                        timestamp: row.get(0)?,
                        message: row.get(1)?,
                        message_type: row.get(2)?,
                        project: row.get(3)?,
                        channels: row.get(4)?,
                        delivered: row.get::<_, i32>(5)? != 0,
                        suppressed: row.get::<_, i32>(6)? != 0,
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
