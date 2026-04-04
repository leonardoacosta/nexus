//! IPC message types and stdin/stdout handlers.
//!
//! Protocol: newline-delimited JSON over stdin (inbound) and stdout (outbound).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{RwLock, mpsc};
use tracing::{debug, error, info, warn};

use crate::watcher::{self, SessionState};

// ---------------------------------------------------------------------------
// Inbound messages (Agent -> Watcher via stdin)
// ---------------------------------------------------------------------------

/// Messages the Bun agent sends to the watcher via stdin.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    /// Start watching the given paths for sessions.json changes.
    Watch { paths: Vec<String> },
    /// Graceful shutdown request.
    Shutdown,
}

// ---------------------------------------------------------------------------
// Outbound messages (Watcher -> Agent via stdout)
// ---------------------------------------------------------------------------

/// Messages the watcher sends to the Bun agent via stdout.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    /// A new session was detected in a sessions.json file.
    SessionStart {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        project: Option<String>,
        path: String,
    },
    /// An existing session was updated (heartbeat, status change, etc.).
    SessionUpdate {
        session_id: String,
        timestamp: String,
    },
    /// A previously known session is no longer present.
    SessionEnd {
        session_id: String,
    },
    /// Acknowledgement that a watch command was processed.
    WatchAck {
        paths: Vec<String>,
    },
    /// An error occurred.
    Error {
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Stdout writer
// ---------------------------------------------------------------------------

/// Reads outbound messages from the channel and writes them as newline-delimited
/// JSON to stdout. Exits when the channel is closed.
pub async fn stdout_writer(mut rx: mpsc::Receiver<OutboundMessage>) {
    let mut stdout = tokio::io::stdout();

    while let Some(msg) = rx.recv().await {
        match serde_json::to_string(&msg) {
            Ok(json) => {
                let line = format!("{}\n", json);
                if let Err(e) = stdout.write_all(line.as_bytes()).await {
                    error!("failed to write to stdout: {}", e);
                    break;
                }
                if let Err(e) = stdout.flush().await {
                    error!("failed to flush stdout: {}", e);
                    break;
                }
            }
            Err(e) => {
                error!("failed to serialize outbound message: {}", e);
            }
        }
    }

    debug!("stdout writer exiting");
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/// Reads newline-delimited JSON commands from stdin and dispatches them.
/// Sends a message on `shutdown_tx` when a shutdown command is received or
/// stdin reaches EOF.
pub async fn stdin_reader(
    outbound_tx: mpsc::Sender<OutboundMessage>,
    state: Arc<RwLock<SessionState>>,
    shutdown_tx: mpsc::Sender<()>,
) {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // EOF — parent process closed stdin.
                info!("stdin closed (EOF), requesting shutdown");
                let _ = shutdown_tx.send(()).await;
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                match serde_json::from_str::<InboundMessage>(trimmed) {
                    Ok(msg) => {
                        handle_inbound(msg, &outbound_tx, &state, &shutdown_tx).await;
                    }
                    Err(e) => {
                        warn!("failed to parse inbound message: {} — input: {}", e, trimmed);
                        let _ = outbound_tx
                            .send(OutboundMessage::Error {
                                message: format!("invalid message: {}", e),
                            })
                            .await;
                    }
                }
            }
            Err(e) => {
                error!("stdin read error: {}", e);
                let _ = shutdown_tx.send(()).await;
                break;
            }
        }
    }
}

/// Dispatch an inbound command.
async fn handle_inbound(
    msg: InboundMessage,
    outbound_tx: &mpsc::Sender<OutboundMessage>,
    state: &Arc<RwLock<SessionState>>,
    shutdown_tx: &mpsc::Sender<()>,
) {
    match msg {
        InboundMessage::Watch { paths } => {
            info!("received watch command for {} path(s)", paths.len());

            // Acknowledge the watch command.
            let _ = outbound_tx
                .send(OutboundMessage::WatchAck {
                    paths: paths.clone(),
                })
                .await;

            // Spawn a file watcher for each path.
            for path in paths {
                let tx = outbound_tx.clone();
                let st = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = watcher::watch_path(&path, tx, st).await {
                        error!("watcher for {} failed: {}", path, e);
                    }
                });
            }
        }
        InboundMessage::Shutdown => {
            info!("received shutdown command");
            let _ = shutdown_tx.send(()).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_watch_message() {
        let json = r#"{"type":"watch","paths":["/home/user/.claude"]}"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        match msg {
            InboundMessage::Watch { paths } => {
                assert_eq!(paths, vec!["/home/user/.claude"]);
            }
            _ => panic!("expected Watch variant"),
        }
    }

    #[test]
    fn parse_shutdown_message() {
        let json = r#"{"type":"shutdown"}"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, InboundMessage::Shutdown));
    }

    #[test]
    fn serialize_session_start() {
        let msg = OutboundMessage::SessionStart {
            session_id: "abc123".into(),
            project: Some("co".into()),
            path: "/home/user/.claude/projects/co/sessions.json".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"session_start""#));
        assert!(json.contains(r#""session_id":"abc123""#));
        assert!(json.contains(r#""project":"co""#));
    }

    #[test]
    fn serialize_session_update() {
        let msg = OutboundMessage::SessionUpdate {
            session_id: "abc123".into(),
            timestamp: "2026-04-03T12:00:00Z".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"session_update""#));
        assert!(json.contains(r#""timestamp":"2026-04-03T12:00:00Z""#));
    }

    #[test]
    fn serialize_session_end() {
        let msg = OutboundMessage::SessionEnd {
            session_id: "abc123".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"session_end""#));
    }

    #[test]
    fn serialize_session_start_without_project() {
        let msg = OutboundMessage::SessionStart {
            session_id: "abc123".into(),
            project: None,
            path: "/tmp/sessions.json".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        // The "project" key should not appear when None.
        assert!(
            !json.contains(r#""project""#),
            "expected no project key, got: {}",
            json
        );
    }

    #[test]
    fn serialize_error() {
        let msg = OutboundMessage::Error {
            message: "something went wrong".into(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"error""#));
        assert!(json.contains("something went wrong"));
    }
}
