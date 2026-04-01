//! Session CRUD operations.

use anyhow::Result;
use rusqlite::params;

use super::types::{SessionRecord, SessionUpdate};
use super::NexusDb;

impl NexusDb {
    /// Insert a new session record.
    pub fn insert_session(&self, session: &SessionRecord) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO sessions (
                    id, pid, project, cwd, branch, started_at, ended_at,
                    last_heartbeat, status, model, session_type,
                    total_cost_usd, rate_limit_utilization, rate_limit_type,
                    tmux_target, cc_session_id, agent
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    session.id,
                    session.pid,
                    session.project,
                    session.cwd,
                    session.branch,
                    session.started_at,
                    session.ended_at,
                    session.last_heartbeat,
                    session.status,
                    session.model,
                    session.session_type,
                    session.total_cost_usd,
                    session.rate_limit_utilization,
                    session.rate_limit_type,
                    session.tmux_target,
                    session.cc_session_id,
                    session.agent,
                ],
            )?;
            Ok(())
        })
    }

    /// Update a session with partial fields (heartbeat, telemetry).
    pub fn update_session(&self, id: &str, updates: &SessionUpdate) -> Result<()> {
        self.write(|conn| {
            // Build SET clauses dynamically based on which fields are Some.
            let mut sets: Vec<String> = Vec::new();
            let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            let mut idx = 1u32;

            if let Some(ref v) = updates.last_heartbeat {
                sets.push(format!("last_heartbeat = ?{idx}"));
                bind_values.push(Box::new(v.clone()));
                idx += 1;
            }
            if let Some(ref v) = updates.status {
                sets.push(format!("status = ?{idx}"));
                bind_values.push(Box::new(v.clone()));
                idx += 1;
            }
            if let Some(ref v) = updates.model {
                sets.push(format!("model = ?{idx}"));
                bind_values.push(Box::new(v.clone()));
                idx += 1;
            }
            if let Some(v) = updates.total_cost_usd {
                sets.push(format!("total_cost_usd = ?{idx}"));
                bind_values.push(Box::new(v));
                idx += 1;
            }
            if let Some(v) = updates.rate_limit_utilization {
                sets.push(format!("rate_limit_utilization = ?{idx}"));
                bind_values.push(Box::new(v));
                idx += 1;
            }
            if let Some(ref v) = updates.rate_limit_type {
                sets.push(format!("rate_limit_type = ?{idx}"));
                bind_values.push(Box::new(v.clone()));
                idx += 1;
            }

            if sets.is_empty() {
                return Ok(());
            }

            let sql = format!("UPDATE sessions SET {} WHERE id = ?{idx}", sets.join(", "));
            bind_values.push(Box::new(id.to_string()));

            let params: Vec<&dyn rusqlite::types::ToSql> =
                bind_values.iter().map(|b| b.as_ref()).collect();
            conn.execute(&sql, params.as_slice())?;
            Ok(())
        })
    }

    /// Mark a session as ended.
    pub fn end_session(&self, id: &str, ended_at: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "UPDATE sessions SET ended_at = ?1, status = 'ended' WHERE id = ?2",
                params![ended_at, id],
            )?;
            Ok(())
        })
    }

    /// Load all sessions that were active (no `ended_at`) when the agent last shut down.
    pub fn load_active_sessions(&self) -> Result<Vec<SessionRecord>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, pid, project, cwd, branch, started_at, ended_at,
                        last_heartbeat, status, model, session_type,
                        total_cost_usd, rate_limit_utilization, rate_limit_type,
                        tmux_target, cc_session_id, agent
                 FROM sessions WHERE ended_at IS NULL",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(SessionRecord {
                    id: row.get(0)?,
                    pid: row.get(1)?,
                    project: row.get(2)?,
                    cwd: row.get(3)?,
                    branch: row.get(4)?,
                    started_at: row.get(5)?,
                    ended_at: row.get(6)?,
                    last_heartbeat: row.get(7)?,
                    status: row.get(8)?,
                    model: row.get(9)?,
                    session_type: row.get(10)?,
                    total_cost_usd: row.get(11)?,
                    rate_limit_utilization: row.get(12)?,
                    rate_limit_type: row.get(13)?,
                    tmux_target: row.get(14)?,
                    cc_session_id: row.get(15)?,
                    agent: row.get(16)?,
                })
            })?;
            let mut sessions = Vec::new();
            for row in rows {
                sessions.push(row?);
            }
            Ok(sessions)
        })
    }
}
