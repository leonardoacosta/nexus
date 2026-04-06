//! SQLite backing store for Nexus.
//!
//! Provides a thread-safe wrapper around a `rusqlite::Connection` with WAL mode,
//! schema migrations, spec governance CRUD, and retention cleanup.

use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;

mod credentials;
mod cron;
mod events;
mod failures;
mod git_events;
pub mod helpers;
mod health;
mod lifecycle;
mod migrations;
mod notifications;
mod retention;
mod sessions;
mod snapshots;
mod specs;
#[cfg(test)]
mod tests;
pub mod types;

pub use helpers::proposal_hash;
pub use types::*;

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
    pub fn open(path: &std::path::Path) -> Result<Self> {
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
        let conn = self.conn.lock();
        f(&conn)
    }

    /// Execute a read closure against the database.
    pub fn read<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let conn = self.conn.lock();
        f(&conn)
    }

    /// Run schema migrations up to the latest version.
    ///
    /// Each migration is a function that takes `&Connection` and runs DDL.
    /// The current schema version is tracked via `PRAGMA user_version`.
    pub fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();

        let current_version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        let migrations: Vec<fn(&Connection) -> Result<()>> = vec![
            migrations::migrate_v1,
            migrations::migrate_v2,
            migrations::migrate_v3,
            migrations::migrate_v4,
        ];

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
}
