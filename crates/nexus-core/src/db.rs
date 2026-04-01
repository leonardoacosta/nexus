//! SQLite backing store for Nexus.
//!
//! Provides a thread-safe wrapper around a `rusqlite::Connection` with WAL mode,
//! schema migrations, spec governance CRUD, and retention cleanup.

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// NexusDb — core wrapper
// ---------------------------------------------------------------------------

/// Thread-safe SQLite database wrapper.
///
/// Uses a single connection behind a `Mutex`. WAL journal mode allows
/// concurrent readers in SQLite itself, but our access is serialised
/// through the mutex for simplicity in Phase 1.
pub struct NexusDb {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for NexusDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NexusDb").finish_non_exhaustive()
    }
}

impl NexusDb {
    /// Open (or create) a database at `path` with production PRAGMAs.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
        ",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory database (useful for tests across crates).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
        ",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Execute a write closure against the database.
    pub fn write<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    /// Execute a read closure against the database.
    pub fn read<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    // -----------------------------------------------------------------------
    // Migrations
    // -----------------------------------------------------------------------

    /// Run schema migrations up to the latest version.
    ///
    /// Each migration is a function that takes `&Connection` and runs DDL.
    /// The current schema version is tracked via `PRAGMA user_version`.
    pub fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

        let current_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        let migrations: Vec<fn(&Connection) -> Result<()>> = vec![migrate_v1];

        for (i, migration) in migrations.iter().enumerate() {
            let version = (i + 1) as u32;
            if current_version < version {
                migration(&conn).with_context(|| format!("migration v{version} failed"))?;
                conn.pragma_update(None, "user_version", version)?;
                tracing::info!("applied migration v{version}");
            }
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Spec CRUD
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Session CRUD
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Failure CRUD
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Event logging
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Retention cleanup
    // -----------------------------------------------------------------------

    /// Prune old records according to retention policy.
    ///
    /// - Sessions, failures, events: `session_days` (typically 30).
    /// - Archived specs: `spec_archive_days` (typically 90).
    pub fn prune_old_records(
        &self,
        session_days: i64,
        spec_archive_days: i64,
    ) -> Result<PruneStats> {
        self.write(|conn| {
            let sessions_deleted = conn.execute(
                "DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let failures_deleted = conn.execute(
                "DELETE FROM failures WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let events_deleted = conn.execute(
                "DELETE FROM events WHERE timestamp < datetime('now', ?1)",
                params![format!("-{session_days} days")],
            )?;

            let specs_deleted = conn.execute(
                "DELETE FROM specs WHERE status = 'archived' AND archived_at < datetime('now', ?1)",
                params![format!("-{spec_archive_days} days")],
            )?;

            Ok(PruneStats {
                sessions_deleted,
                failures_deleted,
                events_deleted,
                specs_deleted,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// V1 Migration
// ---------------------------------------------------------------------------

fn migrate_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS specs (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread',
            title TEXT,
            summary TEXT,
            tasks_total INTEGER DEFAULT 0,
            tasks_done INTEGER DEFAULT 0,
            proposal_hash TEXT,
            discovered_at TEXT NOT NULL,
            read_at TEXT,
            approved_at TEXT,
            applied_at TEXT,
            archived_at TEXT,
            rejected_at TEXT,
            rejection_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_specs_project ON specs(project);
        CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            pid INTEGER,
            project TEXT,
            cwd TEXT,
            branch TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            last_heartbeat TEXT,
            status TEXT,
            model TEXT,
            session_type TEXT,
            total_cost_usd REAL,
            rate_limit_utilization REAL,
            rate_limit_type TEXT,
            tmux_target TEXT,
            cc_session_id TEXT,
            agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

        CREATE TABLE IF NOT EXISTS failures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            error_summary TEXT,
            project TEXT,
            session_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_failures_timestamp ON failures(timestamp);
        CREATE INDEX IF NOT EXISTS idx_failures_tool ON failures(tool_name);
        CREATE INDEX IF NOT EXISTS idx_failures_project ON failures(project);

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            actor TEXT,
            target TEXT,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
        ",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A row from the `specs` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpecRecord {
    pub id: String,
    pub project: String,
    pub name: String,
    pub status: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tasks_total: u32,
    pub tasks_done: u32,
    pub proposal_hash: Option<String>,
    pub discovered_at: String,
    pub read_at: Option<String>,
    pub approved_at: Option<String>,
    pub applied_at: Option<String>,
    pub archived_at: Option<String>,
    pub rejected_at: Option<String>,
    pub rejection_reason: Option<String>,
}

/// A row from the `sessions` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub pid: Option<i64>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub last_heartbeat: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub session_type: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub rate_limit_utilization: Option<f32>,
    pub rate_limit_type: Option<String>,
    pub tmux_target: Option<String>,
    pub cc_session_id: Option<String>,
    pub agent: Option<String>,
}

/// Partial update for a session (heartbeat, telemetry fields).
#[derive(Debug, Clone, Default)]
pub struct SessionUpdate {
    pub last_heartbeat: Option<String>,
    pub status: Option<String>,
    pub model: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub rate_limit_utilization: Option<f32>,
    pub rate_limit_type: Option<String>,
}

/// A row from the `failures` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FailureRecord {
    pub timestamp: String,
    pub tool_name: String,
    pub error_summary: Option<String>,
    pub project: Option<String>,
    pub session_id: Option<String>,
}

/// Query parameters for filtering failures.
#[derive(Debug, Clone, Default)]
pub struct FailureQuery {
    pub tool_name: Option<String>,
    pub project: Option<String>,
    pub since: Option<String>,
    pub limit: Option<u32>,
}

/// A row from the `events` table.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EventRecord {
    pub id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub actor: Option<String>,
    pub target: Option<String>,
    pub details: Option<String>,
}

/// Stats returned by `prune_old_records`.
#[derive(Debug)]
pub struct PruneStats {
    pub sessions_deleted: usize,
    pub failures_deleted: usize,
    pub events_deleted: usize,
    pub specs_deleted: usize,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Compute SHA-256 of file content, returned as a hex string.
pub fn proposal_hash(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

/// Truncate a string to at most `max_len` characters (first line only).
fn truncate_summary(s: &str, max_len: usize) -> String {
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() > max_len {
        format!("{}...", &first_line[..max_len])
    } else {
        first_line.to_string()
    }
}

/// Extension trait to convert `rusqlite::Error` into `Option` for missing rows.
trait OptionalExt<T> {
    fn optional(self) -> std::result::Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for std::result::Result<T, rusqlite::Error> {
    fn optional(self) -> std::result::Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> NexusDb {
        let db = NexusDb::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn make_spec(project: &str, name: &str) -> SpecRecord {
        SpecRecord {
            id: format!("{project}/{name}"),
            project: project.to_string(),
            name: name.to_string(),
            status: "unread".to_string(),
            title: Some("Test spec".to_string()),
            summary: None,
            tasks_total: 10,
            tasks_done: 0,
            proposal_hash: Some("abc123".to_string()),
            discovered_at: chrono::Utc::now().to_rfc3339(),
            read_at: None,
            approved_at: None,
            applied_at: None,
            archived_at: None,
            rejected_at: None,
            rejection_reason: None,
        }
    }

    // -------------------------------------------------------------------
    // Task 1.6: Database foundation tests
    // -------------------------------------------------------------------

    #[test]
    fn open_and_migrate() {
        let db = test_db();
        let version: u32 = db
            .read(|conn| Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn migrate_is_idempotent() {
        let db = test_db();
        db.migrate().unwrap();
        let version: u32 = db
            .read(|conn| Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn tables_exist_after_migration() {
        let db = test_db();
        let tables: Vec<String> = db
            .read(|conn| {
                let mut stmt = conn
                    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                let mut names = Vec::new();
                for row in rows {
                    names.push(row?);
                }
                Ok(names)
            })
            .unwrap();

        assert!(tables.contains(&"specs".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"failures".to_string()));
        assert!(tables.contains(&"events".to_string()));
    }

    #[test]
    fn wal_mode_enabled() {
        let db = test_db();
        let mode: String = db
            .read(|conn| Ok(conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?))
            .unwrap();
        assert!(mode == "wal" || mode == "memory");
    }

    // -------------------------------------------------------------------
    // Task 2.6: Spec CRUD tests
    // -------------------------------------------------------------------

    #[test]
    fn upsert_and_get_spec() {
        let db = test_db();
        let spec = make_spec("oo", "add-auth");
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(fetched.id, "oo/add-auth");
        assert_eq!(fetched.status, "unread");
        assert_eq!(fetched.tasks_total, 10);
        assert_eq!(fetched.tasks_done, 0);
        assert_eq!(fetched.proposal_hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn get_nonexistent_spec_returns_none() {
        let db = test_db();
        let result = db.get_spec("oo", "nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn upsert_updates_existing_spec() {
        let db = test_db();
        let mut spec = make_spec("oo", "add-auth");
        db.upsert_spec(&spec).unwrap();

        spec.status = "read".to_string();
        spec.tasks_done = 3;
        spec.read_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(fetched.status, "read");
        assert_eq!(fetched.tasks_done, 3);
        assert!(fetched.read_at.is_some());
    }

    #[test]
    fn list_specs_all() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "spec-a")).unwrap();
        db.upsert_spec(&make_spec("nx", "spec-b")).unwrap();

        let all = db.list_specs(None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn list_specs_with_status_filter() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "spec-a")).unwrap();

        let mut spec_b = make_spec("nx", "spec-b");
        spec_b.status = "approved".to_string();
        db.upsert_spec(&spec_b).unwrap();

        let unread = db.list_specs(Some(&["unread"])).unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].project, "oo");

        let approved = db.list_specs(Some(&["approved"])).unwrap();
        assert_eq!(approved.len(), 1);
        assert_eq!(approved[0].project, "nx");

        let both = db.list_specs(Some(&["unread", "approved"])).unwrap();
        assert_eq!(both.len(), 2);
    }

    #[test]
    fn update_spec_status_test() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "add-auth")).unwrap();

        db.update_spec_status("oo", "add-auth", "read").unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.status, "read");
        assert!(spec.read_at.is_some());

        db.update_spec_status("oo", "add-auth", "approved").unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.status, "approved");
        assert!(spec.approved_at.is_some());
    }

    #[test]
    fn update_spec_tasks_test() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "add-auth")).unwrap();

        db.update_spec_tasks("oo", "add-auth", 5, 10).unwrap();
        let spec = db.get_spec("oo", "add-auth").unwrap().unwrap();
        assert_eq!(spec.tasks_done, 5);
        assert_eq!(spec.tasks_total, 10);
    }

    // -------------------------------------------------------------------
    // Spec lifecycle transitions
    // -------------------------------------------------------------------

    #[test]
    fn spec_lifecycle_unread_to_archived() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "lifecycle")).unwrap();

        for status in &["read", "approved", "applied", "archived"] {
            db.update_spec_status("oo", "lifecycle", status).unwrap();
            let spec = db.get_spec("oo", "lifecycle").unwrap().unwrap();
            assert_eq!(spec.status, *status);
        }
    }

    #[test]
    fn hash_change_resets_to_unread() {
        let db = test_db();
        let mut spec = make_spec("oo", "edited-spec");
        spec.status = "approved".to_string();
        spec.proposal_hash = Some("hash_v1".to_string());
        spec.approved_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        spec.status = "unread".to_string();
        spec.proposal_hash = Some("hash_v2".to_string());
        spec.read_at = None;
        spec.approved_at = None;
        db.upsert_spec(&spec).unwrap();

        let fetched = db.get_spec("oo", "edited-spec").unwrap().unwrap();
        assert_eq!(fetched.status, "unread");
        assert_eq!(fetched.proposal_hash.as_deref(), Some("hash_v2"));
        assert!(fetched.read_at.is_none());
        assert!(fetched.approved_at.is_none());
    }

    // -------------------------------------------------------------------
    // Retention / pruning
    // -------------------------------------------------------------------

    #[test]
    fn prune_old_records_cleans_archived_specs() {
        let db = test_db();
        let mut spec = make_spec("oo", "old-spec");
        spec.status = "archived".to_string();
        spec.archived_at = Some("2020-01-01T00:00:00Z".to_string());
        db.upsert_spec(&spec).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 1);

        let fetched = db.get_spec("oo", "old-spec").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn prune_preserves_recent_archived_specs() {
        let db = test_db();
        let mut spec = make_spec("oo", "recent-spec");
        spec.status = "archived".to_string();
        spec.archived_at = Some(chrono::Utc::now().to_rfc3339());
        db.upsert_spec(&spec).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 0);

        let fetched = db.get_spec("oo", "recent-spec").unwrap();
        assert!(fetched.is_some());
    }

    #[test]
    fn prune_preserves_non_archived_specs() {
        let db = test_db();
        db.upsert_spec(&make_spec("oo", "active-spec")).unwrap();

        let stats = db.prune_old_records(30, 90).unwrap();
        assert_eq!(stats.specs_deleted, 0);
    }

    // -------------------------------------------------------------------
    // proposal_hash helper
    // -------------------------------------------------------------------

    #[test]
    fn proposal_hash_is_deterministic() {
        let h1 = proposal_hash(b"hello world");
        let h2 = proposal_hash(b"hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn proposal_hash_differs_for_different_content() {
        let h1 = proposal_hash(b"version 1");
        let h2 = proposal_hash(b"version 2");
        assert_ne!(h1, h2);
    }

    // -------------------------------------------------------------------
    // Task 4.4: Session persistence round-trip tests
    // -------------------------------------------------------------------

    fn make_session(id: &str, project: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            pid: Some(1234),
            project: Some(project.to_string()),
            cwd: Some("/home/user/dev".to_string()),
            branch: Some("main".to_string()),
            started_at: chrono::Utc::now().to_rfc3339(),
            ended_at: None,
            last_heartbeat: Some(chrono::Utc::now().to_rfc3339()),
            status: Some("active".to_string()),
            model: Some("opus".to_string()),
            session_type: Some("ad_hoc".to_string()),
            total_cost_usd: Some(0.05),
            rate_limit_utilization: Some(0.3),
            rate_limit_type: Some("model".to_string()),
            tmux_target: Some("main:0.1".to_string()),
            cc_session_id: Some("cc-123".to_string()),
            agent: Some("test-agent".to_string()),
        }
    }

    #[test]
    fn insert_and_load_session() {
        let db = test_db();
        let session = make_session("sess-1", "oo");
        db.insert_session(&session).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "sess-1");
        assert_eq!(active[0].project.as_deref(), Some("oo"));
        assert_eq!(active[0].model.as_deref(), Some("opus"));
    }

    #[test]
    fn update_session_partial() {
        let db = test_db();
        db.insert_session(&make_session("sess-2", "nx")).unwrap();

        let update = SessionUpdate {
            model: Some("sonnet".to_string()),
            total_cost_usd: Some(1.5),
            ..Default::default()
        };
        db.update_session("sess-2", &update).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active[0].model.as_deref(), Some("sonnet"));
        assert_eq!(active[0].total_cost_usd, Some(1.5));
        // Unchanged fields remain.
        assert_eq!(active[0].project.as_deref(), Some("nx"));
    }

    #[test]
    fn end_session_removes_from_active() {
        let db = test_db();
        db.insert_session(&make_session("sess-3", "tc")).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        db.end_session("sess-3", &now).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert!(active.is_empty());
    }

    #[test]
    fn load_active_sessions_excludes_ended() {
        let db = test_db();
        db.insert_session(&make_session("sess-a", "oo")).unwrap();
        db.insert_session(&make_session("sess-b", "nx")).unwrap();

        let now = chrono::Utc::now().to_rfc3339();
        db.end_session("sess-a", &now).unwrap();

        let active = db.load_active_sessions().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "sess-b");
    }

    // -------------------------------------------------------------------
    // Task 5.5: Failure aggregation tests
    // -------------------------------------------------------------------

    fn make_failure(tool: &str, project: &str, error: &str) -> FailureRecord {
        FailureRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: tool.to_string(),
            error_summary: Some(error.to_string()),
            project: Some(project.to_string()),
            session_id: Some("test-session".to_string()),
        }
    }

    #[test]
    fn insert_and_query_failures() {
        let db = test_db();
        db.insert_failure(&make_failure("Bash", "oo", "command failed"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "file not found"))
            .unwrap();
        db.insert_failure(&make_failure("Bash", "oo", "command failed"))
            .unwrap();

        let all = db.query_failures(&FailureQuery::default()).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn query_failures_with_tool_filter() {
        let db = test_db();
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "err"))
            .unwrap();

        let bash_only = db
            .query_failures(&FailureQuery {
                tool_name: Some("Bash".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(bash_only.len(), 1);
        assert_eq!(bash_only[0].tool_name, "Bash");
    }

    #[test]
    fn count_by_tool_test() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Bash", "oo", "err"))
            .unwrap();
        db.insert_failure(&make_failure("Read", "tc", "err"))
            .unwrap();

        let counts = db.count_by_tool(cutoff).unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].0, "Bash");
        assert_eq!(counts[0].1, 2);
        assert_eq!(counts[1].0, "Read");
        assert_eq!(counts[1].1, 1);
    }

    #[test]
    fn count_by_project_empty_becomes_global() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        db.insert_failure(&FailureRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            tool_name: "Bash".to_string(),
            error_summary: Some("err".to_string()),
            project: Some(String::new()),
            session_id: None,
        })
        .unwrap();

        let counts = db.count_by_project(cutoff).unwrap();
        assert_eq!(counts[0].0, "(global)");
    }

    #[test]
    fn top_errors_test() {
        let db = test_db();
        let cutoff = "2000-01-01T00:00:00Z";
        for _ in 0..5 {
            db.insert_failure(&make_failure("Bash", "oo", "command failed"))
                .unwrap();
        }
        for _ in 0..3 {
            db.insert_failure(&make_failure("Read", "tc", "file not found"))
                .unwrap();
        }

        let top = db.top_errors(cutoff, 10).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].0, "command failed");
        assert_eq!(top[0].1, 5);
        assert_eq!(top[1].0, "file not found");
        assert_eq!(top[1].1, 3);
    }

    // -------------------------------------------------------------------
    // Event logging tests
    // -------------------------------------------------------------------

    #[test]
    fn log_and_query_events() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", Some("started"))
            .unwrap();
        db.log_event("session_stop", "agent", "sess-1", None)
            .unwrap();

        let all = db.query_events(None, None, 100).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn query_events_by_type() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", None)
            .unwrap();
        db.log_event("session_stop", "agent", "sess-1", None)
            .unwrap();
        db.log_event("spec_status", "watcher", "oo/spec", None)
            .unwrap();

        let starts = db.query_events(Some("session_start"), None, 100).unwrap();
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].event_type, "session_start");
    }

    #[test]
    fn query_events_by_target() {
        let db = test_db();
        db.log_event("session_start", "agent", "sess-1", None)
            .unwrap();
        db.log_event("session_start", "agent", "sess-2", None)
            .unwrap();

        let events = db.query_events(None, Some("sess-1"), 100).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].target.as_deref(), Some("sess-1"));
    }

    #[test]
    fn query_events_respects_limit() {
        let db = test_db();
        for i in 0..10 {
            db.log_event("test", "agent", &format!("target-{i}"), None)
                .unwrap();
        }

        let events = db.query_events(None, None, 3).unwrap();
        assert_eq!(events.len(), 3);
    }
}
