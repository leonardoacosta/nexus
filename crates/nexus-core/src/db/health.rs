//! Health sample CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::HealthSampleRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert a health sample.
    pub fn insert_health_sample(&self, sample: &HealthSampleRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO health_samples (
                    timestamp, cpu_percent, memory_used_gb, memory_total_gb,
                    disk_used_gb, disk_total_gb, load1, load5, load15, uptime_seconds
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    sample.timestamp,
                    sample.cpu_percent,
                    sample.memory_used_gb,
                    sample.memory_total_gb,
                    sample.disk_used_gb,
                    sample.disk_total_gb,
                    sample.load1,
                    sample.load5,
                    sample.load15,
                    sample.uptime_seconds,
                ],
            )?;
            Ok(())
        })
    }

    /// Query health samples since a given timestamp, ordered by timestamp descending.
    pub fn query_health_samples(
        &self,
        since: Option<&str>,
        limit: u32,
    ) -> Result<Vec<HealthSampleRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match since {
                Some(s) => (
                    "SELECT timestamp, cpu_percent, memory_used_gb, memory_total_gb,
                                disk_used_gb, disk_total_gb, load1, load5, load15, uptime_seconds
                         FROM health_samples WHERE timestamp >= ?1
                         ORDER BY timestamp DESC LIMIT ?2"
                        .to_string(),
                    vec![s.to_string()],
                ),
                None => (
                    "SELECT timestamp, cpu_percent, memory_used_gb, memory_total_gb,
                            disk_used_gb, disk_total_gb, load1, load5, load15, uptime_seconds
                     FROM health_samples ORDER BY timestamp DESC LIMIT ?1"
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
                    Ok(HealthSampleRecord {
                        timestamp: row.get(0)?,
                        cpu_percent: row.get(1)?,
                        memory_used_gb: row.get(2)?,
                        memory_total_gb: row.get(3)?,
                        disk_used_gb: row.get(4)?,
                        disk_total_gb: row.get(5)?,
                        load1: row.get(6)?,
                        load5: row.get(7)?,
                        load15: row.get(8)?,
                        uptime_seconds: row.get(9)?,
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
