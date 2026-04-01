//! Failure CRUD and aggregation operations.

use anyhow::Result;
use rusqlite::params;

use super::helpers::truncate_summary;
use super::types::{FailureQuery, FailureRecord};
use super::NexusDb;

impl NexusDb {
    /// Insert a failure event.
    pub fn insert_failure(&self, failure: &FailureRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO failures (timestamp, tool_name, error_summary, project, session_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    failure.timestamp,
                    failure.tool_name,
                    failure.error_summary,
                    failure.project,
                    failure.session_id,
                ],
            )?;
            Ok(())
        })
    }

    /// Query failures with optional filters.
    pub fn query_failures(&self, filters: &FailureQuery) -> Result<Vec<FailureRecord>> {
        self.read(|conn| {
            let mut conditions: Vec<String> = Vec::new();
            let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            let mut idx = 1u32;

            if let Some(ref tool) = filters.tool_name {
                conditions.push(format!("tool_name = ?{idx}"));
                bind_values.push(Box::new(tool.clone()));
                idx += 1;
            }
            if let Some(ref project) = filters.project {
                conditions.push(format!("project = ?{idx}"));
                bind_values.push(Box::new(project.clone()));
                idx += 1;
            }
            if let Some(ref since) = filters.since {
                conditions.push(format!("timestamp >= ?{idx}"));
                bind_values.push(Box::new(since.clone()));
                idx += 1;
            }

            let where_clause = if conditions.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", conditions.join(" AND "))
            };

            let limit = filters.limit.unwrap_or(1000);
            let sql = format!(
                "SELECT timestamp, tool_name, error_summary, project, session_id
                 FROM failures {where_clause}
                 ORDER BY timestamp DESC LIMIT ?{idx}"
            );
            bind_values.push(Box::new(limit as i64));

            let params: Vec<&dyn rusqlite::types::ToSql> =
                bind_values.iter().map(|b| b.as_ref()).collect();

            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params.as_slice(), |row| {
                Ok(FailureRecord {
                    timestamp: row.get(0)?,
                    tool_name: row.get(1)?,
                    error_summary: row.get(2)?,
                    project: row.get(3)?,
                    session_id: row.get(4)?,
                })
            })?;

            let mut failures = Vec::new();
            for row in rows {
                failures.push(row?);
            }
            Ok(failures)
        })
    }

    /// Count failures grouped by tool name since a given timestamp.
    pub fn count_by_tool(&self, since: &str) -> Result<Vec<(String, i64)>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT tool_name, COUNT(*) as cnt
                 FROM failures WHERE timestamp >= ?1
                 GROUP BY tool_name ORDER BY cnt DESC",
            )?;
            let rows = stmt.query_map(params![since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }

    /// Count failures grouped by project since a given timestamp.
    pub fn count_by_project(&self, since: &str) -> Result<Vec<(String, i64)>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT COALESCE(NULLIF(project, ''), '(global)'), COUNT(*) as cnt
                 FROM failures WHERE timestamp >= ?1
                 GROUP BY project ORDER BY cnt DESC",
            )?;
            let rows = stmt.query_map(params![since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }

    /// Failure count per day for the last `days` days.
    pub fn failure_trend(&self, days: i64) -> Result<Vec<(String, i64)>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DATE(timestamp) as day, COUNT(*) as cnt
                 FROM failures
                 WHERE timestamp >= datetime('now', ?1)
                 GROUP BY day ORDER BY day DESC",
            )?;
            let rows = stmt.query_map(params![format!("-{days} days")], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?;
            let mut results = Vec::new();
            for row in rows {
                results.push(row?);
            }
            Ok(results)
        })
    }

    /// Count total failures in a time window (current period).
    pub fn count_failures_since(&self, since: &str) -> Result<i64> {
        self.read(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM failures WHERE timestamp >= ?1",
                params![since],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// Count total failures in a time range (for previous period comparison).
    pub fn count_failures_between(&self, from: &str, to: &str) -> Result<i64> {
        self.read(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM failures WHERE timestamp >= ?1 AND timestamp < ?2",
                params![from, to],
                |row| row.get(0),
            )?;
            Ok(count)
        })
    }

    /// Top error summaries (truncated to first line, 60 chars) since a timestamp.
    pub fn top_errors(&self, since: &str, limit: usize) -> Result<Vec<(String, i64, String)>> {
        self.read(|conn| {
            // SQLite doesn't have a good SUBSTR-to-newline, so we fetch raw and
            // truncate in Rust — same as the old in-memory code.
            let mut stmt = conn
                .prepare("SELECT error_summary, tool_name FROM failures WHERE timestamp >= ?1")?;
            let rows = stmt.query_map(params![since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;

            let mut groups: std::collections::HashMap<String, (i64, String)> =
                std::collections::HashMap::new();
            for row in rows {
                let (error, tool) = row?;
                let key = truncate_summary(&error, 60);
                let entry = groups.entry(key).or_insert((0, tool));
                entry.0 += 1;
            }

            let mut sorted: Vec<(String, i64, String)> = groups
                .into_iter()
                .map(|(summary, (count, tool))| (summary, count, tool))
                .collect();
            sorted.sort_by(|a, b| b.1.cmp(&a.1));
            sorted.truncate(limit);
            Ok(sorted)
        })
    }
}
