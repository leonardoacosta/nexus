//! Cron run CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::CronRunRecord;
use super::NexusDb;

impl NexusDb {
    /// Insert a cron run record.
    pub fn insert_cron_run(&self, run: &CronRunRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO cron_runs (timestamp, job, status, details, duration_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    run.timestamp,
                    run.job,
                    run.status,
                    run.details,
                    run.duration_ms,
                ],
            )?;
            Ok(())
        })
    }

    /// Query cron runs with optional job filter, ordered by timestamp descending.
    pub fn query_cron_runs(
        &self,
        job: Option<&str>,
        limit: u32,
    ) -> Result<Vec<CronRunRecord>> {
        self.read(|conn| {
            let (sql, bind_values): (String, Vec<String>) = match job {
                Some(j) => (
                    "SELECT id, timestamp, job, status, details, duration_ms
                     FROM cron_runs WHERE job = ?1
                     ORDER BY timestamp DESC LIMIT ?2"
                        .to_string(),
                    vec![j.to_string()],
                ),
                None => (
                    "SELECT id, timestamp, job, status, details, duration_ms
                     FROM cron_runs
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
                    Ok(CronRunRecord {
                        id: row.get(0)?,
                        timestamp: row.get(1)?,
                        job: row.get(2)?,
                        status: row.get(3)?,
                        details: row.get(4)?,
                        duration_ms: row.get(5)?,
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
