//! SQLite backing store for Nexus.
//!
//! Provides a thread-safe wrapper around a `rusqlite::Connection` with WAL mode,
//! schema migrations, spec governance CRUD, and retention cleanup.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
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
}
