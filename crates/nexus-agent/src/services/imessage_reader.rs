//! iMessage reader service (macOS only)
//!
//! Polls ~/Library/Messages/chat.db for new messages from the configured
//! iMessage recipient. Announces new messages via TTS and stores them
//! for API access. Future: command dispatch to Claude sessions.

use crate::config::NotificationsConfig;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

/// A message read from the iMessage database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IMessageRecord {
    pub rowid: i64,
    pub text: String,
    pub date: String, // ISO 8601
    pub is_from_me: bool,
    pub sender: String, // handle_id resolved to address
}

/// iMessage reader service
pub struct IMessageReaderService {
    poll_interval_secs: u64,
    shared_config: Arc<RwLock<NotificationsConfig>>,
    /// Recent messages buffer — shared with HTTP handler
    pub messages: Arc<RwLock<Vec<IMessageRecord>>>,
}

impl IMessageReaderService {
    pub fn new(poll_interval_secs: u64, shared_config: Arc<RwLock<NotificationsConfig>>) -> Self {
        Self {
            poll_interval_secs,
            shared_config,
            messages: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Get the iMessage database path
    fn db_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join("Library/Messages/chat.db")
    }

    /// Query for new messages from the recipient since last_rowid
    fn query_new_messages(
        db_path: &PathBuf,
        recipient: &str,
        last_rowid: i64,
    ) -> Result<Vec<IMessageRecord>> {
        let conn = Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        // Query messages from the recipient's handle, newer than last_rowid
        // chat.db uses Apple's CoreData timestamp: nanoseconds since 2001-01-01
        // Convert to ISO 8601 via SQLite datetime()
        let mut stmt = conn.prepare(
            "SELECT m.ROWID, m.text,
                    datetime(m.date / 1000000000 + 978307200, 'unixepoch', 'localtime') as date_str,
                    m.is_from_me,
                    COALESCE(h.id, '') as handle
             FROM message m
             LEFT JOIN handle h ON m.handle_id = h.ROWID
             WHERE m.ROWID > ?1
               AND h.id LIKE ?2
               AND m.text IS NOT NULL
               AND m.text != ''
             ORDER BY m.ROWID ASC
             LIMIT 50",
        )?;

        let recipient_pattern = format!("%{}%", recipient);
        let rows = stmt.query_map(rusqlite::params![last_rowid, recipient_pattern], |row| {
            Ok(IMessageRecord {
                rowid: row.get(0)?,
                text: row.get(1)?,
                date: row.get(2)?,
                is_from_me: row.get::<_, i32>(3)? == 1,
                sender: row.get(4)?,
            })
        })?;

        let mut messages = Vec::new();
        for row in rows {
            match row {
                Ok(msg) => messages.push(msg),
                Err(e) => warn!("Failed to read message row: {}", e),
            }
        }

        Ok(messages)
    }

    /// Send a TTS notification for a new message using macOS `say` command
    async fn announce_message(message: &IMessageRecord) {
        let display_text = if message.text.len() > 100 {
            format!("New iMessage: {}...", &message.text[..100])
        } else {
            format!("New iMessage: {}", message.text)
        };

        match tokio::process::Command::new("say")
            .arg(&display_text)
            .output()
            .await
        {
            Ok(_) => debug!("TTS announced iMessage"),
            Err(e) => warn!("Failed to announce iMessage via say: {}", e),
        }
    }

    /// Persist messages buffer to disk for HTTP endpoint access
    fn persist_to_disk(messages: &[IMessageRecord]) {
        let home = std::env::var("HOME").unwrap_or_default();
        let messages_path = PathBuf::from(&home).join(".claude/state/imessages.json");
        if let Some(parent) = messages_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(messages) {
            if let Err(e) = std::fs::write(&messages_path, json) {
                warn!("Failed to persist iMessages to disk: {}", e);
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[async_trait::async_trait]
impl crate::Service for IMessageReaderService {
    fn name(&self) -> &'static str {
        "imessage-reader"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!("iMessage reader service starting");

        let db_path = Self::db_path();
        if !db_path.exists() {
            warn!(
                "iMessage database not found at {:?}. Full Disk Access may be required.",
                db_path
            );
            // Still run — the file might appear later or permissions might change
        }

        // Initialize last_rowid to current max to avoid replaying history on startup
        let mut last_rowid: i64 = {
            match Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(conn) => conn
                    .query_row("SELECT COALESCE(MAX(ROWID), 0) FROM message", [], |row| {
                        row.get(0)
                    })
                    .unwrap_or(0),
                Err(e) => {
                    warn!("Cannot open chat.db on startup: {}. Will retry on poll.", e);
                    0
                }
            }
        };
        info!("iMessage reader initialized, last_rowid={}", last_rowid);

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(self.poll_interval_secs));

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("iMessage reader service shutting down");
                    break;
                }
                _ = interval.tick() => {
                    // Read config for recipient
                    let config = self.shared_config.read().await;
                    if !config.imessage.enabled {
                        continue;
                    }
                    let recipient = config.imessage.recipient.clone();
                    drop(config);

                    if recipient.is_empty() {
                        continue;
                    }

                    // Query for new messages
                    match Self::query_new_messages(&db_path, &recipient, last_rowid) {
                        Ok(new_messages) => {
                            if !new_messages.is_empty() {
                                info!(
                                    "Found {} new iMessage(s) from {}",
                                    new_messages.len(),
                                    recipient
                                );

                                // Update last_rowid
                                if let Some(last) = new_messages.last() {
                                    last_rowid = last.rowid;
                                }

                                // Announce via TTS (only messages NOT from me)
                                for msg in &new_messages {
                                    if !msg.is_from_me {
                                        Self::announce_message(msg).await;
                                    }
                                }

                                // Store in buffer (keep last 100)
                                let mut messages = self.messages.write().await;
                                messages.extend(new_messages);
                                if messages.len() > 100 {
                                    let drain_count = messages.len() - 100;
                                    messages.drain(..drain_count);
                                }

                                // Persist to disk for HTTP endpoint access
                                Self::persist_to_disk(&messages);
                            }
                        }
                        Err(e) => {
                            debug!(
                                "iMessage query failed: {} (Full Disk Access may be needed)",
                                e
                            );
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
