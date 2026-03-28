//! Apple Watch device token storage
//!
//! SQLite-based persistent storage for Apple Watch device tokens.
//! Tracks registration, last seen timestamps, and active status.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use std::path::PathBuf;

const DEFAULT_DB_PATH: &str = "~/.claude/scripts/state/watch-tokens.db";

/// SQLite store for Apple Watch device tokens
pub struct WatchTokenStore {
    conn: Connection,
}

/// Apple Watch device registration
#[derive(Debug, Clone)]
pub struct WatchDevice {
    pub device_token: String,
    pub registered_at: DateTime<Utc>,
    pub last_seen: DateTime<Utc>,
    pub platform: String,
    pub is_active: bool,
}

impl WatchTokenStore {
    /// Open or create the token database at the default path
    pub fn open() -> Result<Self> {
        let path = crate::claude_utils::path::expand_home(DEFAULT_DB_PATH);
        Self::open_at(path)
    }

    /// Open at a specific path (primarily for testing)
    pub fn open_at(path: PathBuf) -> Result<Self> {
        // Create parent directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("Failed to create directory: {}", parent.display()))?;
        }

        // Open SQLite connection
        let conn = Connection::open(&path)
            .with_context(|| format!("Failed to open database: {}", path.display()))?;

        // Run migrations
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watch_devices (
                device_token TEXT PRIMARY KEY,
                registered_at TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT 'watchOS',
                is_active INTEGER NOT NULL DEFAULT 1
            )",
            [],
        )
        .context("Failed to create watch_devices table")?;

        Ok(Self { conn })
    }

    /// Register or update a device token
    ///
    /// If the token already exists, updates last_seen and reactivates it.
    /// Otherwise, creates a new registration.
    pub fn register_token(&self, device_token: &str, platform: &str) -> Result<()> {
        let now = Utc::now().to_rfc3339();

        self.conn
            .execute(
                "INSERT INTO watch_devices (device_token, registered_at, last_seen, platform, is_active)
                 VALUES (?1, ?2, ?2, ?3, 1)
                 ON CONFLICT(device_token) DO UPDATE SET
                     last_seen = ?2,
                     platform = ?3,
                     is_active = 1",
                params![device_token, now, platform],
            )
            .context("Failed to register device token")?;

        Ok(())
    }

    /// Get all active device tokens
    pub fn get_active_tokens(&self) -> Result<Vec<WatchDevice>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT device_token, registered_at, last_seen, platform, is_active
                 FROM watch_devices
                 WHERE is_active = 1",
            )
            .context("Failed to prepare query")?;

        let devices = stmt
            .query_map([], |row| {
                let registered_at_str: String = row.get(1)?;
                let last_seen_str: String = row.get(2)?;

                Ok(WatchDevice {
                    device_token: row.get(0)?,
                    registered_at: DateTime::parse_from_rfc3339(&registered_at_str)
                        .unwrap_or_else(|_| Utc::now().into())
                        .with_timezone(&Utc),
                    last_seen: DateTime::parse_from_rfc3339(&last_seen_str)
                        .unwrap_or_else(|_| Utc::now().into())
                        .with_timezone(&Utc),
                    platform: row.get(3)?,
                    is_active: row.get(4)?,
                })
            })
            .context("Failed to query active tokens")?
            .collect::<Result<Vec<_>, _>>()
            .context("Failed to parse device rows")?;

        Ok(devices)
    }

    /// Mark a token as inactive
    ///
    /// Call this when APNS returns 410 (token no longer valid) or other
    /// permanent failure conditions.
    pub fn invalidate_token(&self, device_token: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE watch_devices SET is_active = 0 WHERE device_token = ?1",
                params![device_token],
            )
            .context("Failed to invalidate device token")?;

        Ok(())
    }

    /// Remove tokens not seen in 30 days and marked inactive
    ///
    /// Returns the number of tokens deleted.
    pub fn cleanup_stale(&self) -> Result<usize> {
        let cutoff = (Utc::now() - chrono::Duration::days(30)).to_rfc3339();

        let deleted = self
            .conn
            .execute(
                "DELETE FROM watch_devices
                 WHERE last_seen < ?1 AND is_active = 0",
                params![cutoff],
            )
            .context("Failed to cleanup stale tokens")?;

        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_store() -> (WatchTokenStore, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();
        (store, temp_dir)
    }

    #[test]
    fn test_register_and_retrieve_token() {
        let (store, _temp) = create_test_store();

        store.register_token("test-token-123", "watchOS").unwrap();

        let tokens = store.get_active_tokens().unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].device_token, "test-token-123");
        assert_eq!(tokens[0].platform, "watchOS");
        assert!(tokens[0].is_active);
    }

    #[test]
    fn test_register_updates_last_seen() {
        let (store, _temp) = create_test_store();

        store.register_token("test-token-123", "watchOS").unwrap();

        let tokens1 = store.get_active_tokens().unwrap();
        let first_seen = tokens1[0].last_seen;

        // Wait a bit and re-register
        std::thread::sleep(std::time::Duration::from_millis(10));

        store.register_token("test-token-123", "watchOS").unwrap();

        let tokens2 = store.get_active_tokens().unwrap();
        let second_seen = tokens2[0].last_seen;

        assert!(second_seen > first_seen);
    }

    #[test]
    fn test_invalidate_token() {
        let (store, _temp) = create_test_store();

        store.register_token("test-token-123", "watchOS").unwrap();

        store.invalidate_token("test-token-123").unwrap();

        let tokens = store.get_active_tokens().unwrap();
        assert_eq!(tokens.len(), 0);
    }

    #[test]
    fn test_register_reactivates_token() {
        let (store, _temp) = create_test_store();

        store.register_token("test-token-123", "watchOS").unwrap();

        store.invalidate_token("test-token-123").unwrap();
        assert_eq!(store.get_active_tokens().unwrap().len(), 0);

        // Re-register should reactivate
        store.register_token("test-token-123", "watchOS").unwrap();

        let tokens = store.get_active_tokens().unwrap();
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].is_active);
    }

    #[test]
    fn test_cleanup_stale_tokens() {
        let (store, _temp) = create_test_store();

        // Register a token
        store.register_token("test-token-123", "watchOS").unwrap();

        // Invalidate it
        store.invalidate_token("test-token-123").unwrap();

        // Cleanup should not remove it yet (last_seen is recent)
        let deleted = store.cleanup_stale().unwrap();
        assert_eq!(deleted, 0);

        // Manually set last_seen to 31 days ago
        let old_date = (Utc::now() - chrono::Duration::days(31)).to_rfc3339();
        store
            .conn
            .execute(
                "UPDATE watch_devices SET last_seen = ?1 WHERE device_token = ?2",
                params![old_date, "test-token-123"],
            )
            .unwrap();

        // Now cleanup should remove it
        let deleted = store.cleanup_stale().unwrap();
        assert_eq!(deleted, 1);

        // Verify it's gone
        let tokens = store.get_active_tokens().unwrap();
        assert_eq!(tokens.len(), 0);
    }

    #[test]
    fn test_cleanup_preserves_active_tokens() {
        let (store, _temp) = create_test_store();

        // Register and invalidate first token
        store
            .register_token("old-inactive-token", "watchOS")
            .unwrap();
        store.invalidate_token("old-inactive-token").unwrap();

        // Register second token (keep active)
        store.register_token("old-active-token", "watchOS").unwrap();

        // Make both old
        let old_date = (Utc::now() - chrono::Duration::days(31)).to_rfc3339();
        store
            .conn
            .execute("UPDATE watch_devices SET last_seen = ?1", params![old_date])
            .unwrap();

        // Cleanup should only remove the inactive one
        let deleted = store.cleanup_stale().unwrap();
        assert_eq!(deleted, 1);

        // Active token should still be there
        let tokens = store.get_active_tokens().unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].device_token, "old-active-token");
    }
}
