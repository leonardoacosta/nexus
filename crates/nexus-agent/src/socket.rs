//! Unix domain socket listener for JSON event ingestion.
//!
//! CC hooks write newline-delimited JSON to `/tmp/nexus-agent.sock`
//! (configurable via `NEXUS_SOCKET`). This module:
//!
//! 1. Resolves and validates the socket path (stale-socket cleanup).
//! 2. Binds a `UnixListener` and accepts connections in a loop.
//! 3. Spawns a task per connection that reads lines and dispatches events
//!    to the `SessionRegistry` or forwards notifications to `ReceiverService`.
//! 4. Handles `SocketCommand` messages (mode query/set/cycle, history, type
//!    overrides) by writing a JSON response on the same connection.
//! 5. Shuts down cleanly on cancellation, removing the socket file.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use nexus_core::session::{Session, SessionStatus};
use nexus_core::socket_event::{SocketCommand, SocketEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;

use crate::dispatch::dispatch_answer;
use crate::registry::SessionRegistry;
use crate::services::receiver::ReceiverService;

/// Default socket path, overridable via `NEXUS_SOCKET` env var.
const DEFAULT_SOCKET_PATH: &str = "/tmp/nexus-agent.sock";

/// Resolve the socket path: `NEXUS_SOCKET` env var or `DEFAULT_SOCKET_PATH`.
pub fn socket_path() -> PathBuf {
    std::env::var("NEXUS_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_SOCKET_PATH))
}

/// Inspect a potentially-existing socket file:
///
/// - If it does not exist: proceed normally.
/// - If it exists and a connection attempt succeeds: another instance is
///   running — return `Err`.
/// - If it exists but the connection fails: the socket is stale — remove it.
pub async fn cleanup_stale_socket(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }

    match tokio::net::UnixStream::connect(path).await {
        Ok(_) => {
            anyhow::bail!(
                "socket {:?} already in use — another nexus-agent instance is running",
                path
            );
        }
        Err(_) => {
            tracing::warn!(path = %path.display(), "removing stale socket");
            std::fs::remove_file(path)?;
        }
    }

    Ok(())
}

/// Bind the Unix domain socket and run the accept loop.
///
/// Exits when `cancel` is triggered. The socket file is removed on exit.
pub async fn run_socket_service(
    registry: Arc<SessionRegistry>,
    receiver: Arc<ReceiverService>,
    cancel: CancellationToken,
) -> Result<()> {
    let path = socket_path();

    // Clean up stale socket or bail if another instance is live.
    cleanup_stale_socket(&path).await?;

    let listener = UnixListener::bind(&path)?;
    tracing::info!(path = %path.display(), "socket listener bound");

    loop {
        tokio::select! {
            // Graceful shutdown requested.
            _ = cancel.cancelled() => {
                tracing::info!("socket service shutting down");
                break;
            }

            // New incoming connection.
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _addr)) => {
                        let reg = Arc::clone(&registry);
                        let recv = Arc::clone(&receiver);
                        tokio::spawn(handle_connection(stream, reg, recv));
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "socket accept error");
                    }
                }
            }
        }
    }

    // Remove the socket file so nothing tries to connect to a dead socket.
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(error = %e, "failed to remove socket file on shutdown");
        } else {
            tracing::info!(path = %path.display(), "socket file removed");
        }
    }

    Ok(())
}

/// Read newline-delimited JSON from a single connection.
///
/// Each line is tried first as a `SocketEvent` (fire-and-forget), then as a
/// `SocketCommand` (request/response — JSON reply written before closing).
/// Multiple events can arrive on the same stream before EOF.
async fn handle_connection(
    stream: UnixStream,
    registry: Arc<SessionRegistry>,
    receiver: Arc<ReceiverService>,
) {
    // Split into reader/writer halves so we can both read lines and write
    // command responses on the same stream.
    let (read_half, mut write_half) = stream.into_split();
    let reader = BufReader::new(read_half);
    let mut lines = reader.lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                // Try SocketEvent first (most common path — hooks fire-and-forget)
                if let Ok(event) = serde_json::from_str::<SocketEvent>(&line) {
                    dispatch_event(event, &registry, &receiver).await;
                    continue;
                }
                // Try SocketCommand (query/mutate — expects a JSON response)
                if let Ok(cmd) = serde_json::from_str::<SocketCommand>(&line) {
                    let response = dispatch_command(cmd, &receiver).await;
                    let mut response_line = response;
                    response_line.push('\n');
                    if let Err(e) = write_half.write_all(response_line.as_bytes()).await {
                        tracing::warn!(error = %e, "socket: failed to write command response");
                    }
                    // Commands are single-shot: close after response.
                    break;
                }
                tracing::warn!(raw = %line, "socket: unrecognised JSON (not event or command)");
            }
            Ok(None) => {
                // EOF — client closed the connection.
                break;
            }
            Err(e) => {
                tracing::warn!(error = %e, "socket read error");
                break;
            }
        }
    }
}

/// Route a parsed `SocketEvent` to the appropriate handler.
async fn dispatch_event(
    event: SocketEvent,
    registry: &Arc<SessionRegistry>,
    receiver: &Arc<ReceiverService>,
) {
    match event {
        SocketEvent::SessionStart {
            session_id,
            project,
            cwd,
            model,
            pid,
            branch,
            cc_session_id,
            tmux_target,
        } => {
            let now = chrono::Utc::now();
            let session = Session {
                id: session_id.clone(),
                pid: pid.unwrap_or(0),
                project,
                cwd: cwd.unwrap_or_default(),
                branch,
                started_at: now,
                last_heartbeat: now,
                status: SessionStatus::Active,
                spec: None,
                command: None,
                agent: None,
                tmux_session: None,
                cc_session_id,
                tmux_target: None, // set via register_adhoc
                rate_limit_utilization: None,
                rate_limit_type: None,
                total_cost_usd: None,
                model,
            };
            let inserted = registry.register_adhoc(session, tmux_target.clone()).await;
            tracing::info!(
                session_id = %session_id,
                inserted,
                tmux_target = ?tmux_target,
                "socket: session_start"
            );
        }

        SocketEvent::SessionStop { session_id } => {
            let removed = registry.unregister(&session_id).await;
            tracing::info!(
                session_id = %session_id,
                removed,
                "socket: session_stop"
            );
        }

        SocketEvent::SessionHeartbeat { session_id } => {
            let found = registry.heartbeat(&session_id).await;
            tracing::debug!(
                session_id = %session_id,
                found,
                "socket: session_heartbeat"
            );
        }

        SocketEvent::Notification {
            message,
            message_type,
            channels,
            question,
            session_id: notif_session_id,
        } => {
            tracing::info!(
                %message,
                message_type = message_type.as_deref().unwrap_or("brief"),
                channels = ?channels,
                has_question = question.is_some(),
                "socket: notification — forwarding to ReceiverService"
            );

            // Forward to the TTS/APNs/banner pipeline.
            let ch_slice: Option<&[String]> = channels.as_deref();
            receiver
                .speak_from_socket(&message, message_type.as_deref(), ch_slice)
                .await;

            // If this notification carries a question, record it in the
            // registry so that incoming iMessage answers can be auto-routed.
            if let (Some(q), Some(sid)) = (question, notif_session_id) {
                registry.set_pending_question(&sid, q).await;
            }
        }

        SocketEvent::Answer { text, session_id } => {
            // Resolve the target session and its tmux pane.
            let (target_session_id, tmux_target) = if let Some(sid) = session_id {
                // Explicit session specified — look up its pane.
                match registry.get_tmux_target(&sid).await {
                    Some(pane) => (sid, pane),
                    None => {
                        tracing::warn!(
                            session_id = %sid,
                            "socket: answer — session has no tmux_target, cannot dispatch"
                        );
                        return;
                    }
                }
            } else {
                // Auto-target: find the session with the most recent pending question.
                match registry.get_session_with_pending_question().await {
                    Some((session, _pq)) => match session.tmux_target {
                        Some(pane) => (session.id, pane),
                        None => {
                            tracing::warn!(
                                "socket: answer — auto-target session has no tmux_target"
                            );
                            return;
                        }
                    },
                    None => {
                        tracing::warn!("socket: answer — no session with pending question found");
                        return;
                    }
                }
            };

            tracing::info!(
                session_id = %target_session_id,
                tmux_target = %tmux_target,
                text_len = text.len(),
                "socket: dispatching answer"
            );

            match dispatch_answer(&tmux_target, &text).await {
                Ok(()) => {
                    // Clear pending question now that the answer has been sent.
                    registry.clear_pending_question(&target_session_id).await;
                    tracing::info!(
                        session_id = %target_session_id,
                        "socket: answer dispatched and pending question cleared"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        session_id = %target_session_id,
                        error = %e,
                        "socket: answer dispatch failed"
                    );
                }
            }
        }

        SocketEvent::AgentSpawn {
            session_id,
            agent_type,
            model,
        } => {
            tracing::info!(
                session_id = ?session_id,
                agent_type = ?agent_type,
                model = ?model,
                "socket: agent_spawn (unrouted)"
            );
        }

        SocketEvent::AgentComplete {
            session_id,
            agent_type,
            duration_ms,
        } => {
            tracing::info!(
                session_id = ?session_id,
                agent_type = ?agent_type,
                duration_ms = ?duration_ms,
                "socket: agent_complete (unrouted)"
            );
        }

        SocketEvent::Telemetry { payload } => {
            tracing::debug!(
                keys = ?payload.keys().collect::<Vec<_>>(),
                "socket: telemetry (unrouted)"
            );
        }
    }
}

/// Execute a `SocketCommand` and return a JSON response string.
async fn dispatch_command(cmd: SocketCommand, receiver: &Arc<ReceiverService>) -> String {
    match cmd {
        SocketCommand::ModeQuery => {
            tracing::debug!("socket: command mode_query");
            receiver.mode_query_json()
        }
        SocketCommand::ModeSet { mode } => {
            tracing::info!(mode = %mode, "socket: command mode_set");
            receiver.mode_set_json(&mode)
        }
        SocketCommand::ModeCycle => {
            tracing::info!("socket: command mode_cycle");
            receiver.mode_cycle_json()
        }
        SocketCommand::History { limit } => {
            tracing::debug!(limit = ?limit, "socket: command history");
            receiver.history_json(limit).await
        }
        SocketCommand::TypeSet { name, mode } => {
            tracing::info!(type_name = %name, mode = %mode, "socket: command type_set");
            receiver.type_set_json(&name, &mode)
        }
        SocketCommand::TypeClear { name } => {
            tracing::info!(type_name = %name, "socket: command type_clear");
            receiver.type_clear_json(&name)
        }
    }
}
