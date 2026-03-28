//! Unix domain socket listener for JSON event ingestion.
//!
//! CC hooks write newline-delimited JSON to `/tmp/nexus-agent.sock`
//! (configurable via `NEXUS_SOCKET`). This module:
//!
//! 1. Resolves and validates the socket path (stale-socket cleanup).
//! 2. Binds a `UnixListener` and accepts connections in a loop.
//! 3. Spawns a task per connection that reads lines and dispatches events
//!    to the `SessionRegistry`.
//! 4. Shuts down cleanly on cancellation, removing the socket file.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use nexus_core::session::{Session, SessionStatus};
use nexus_core::socket_event::SocketEvent;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio_util::sync::CancellationToken;

use crate::registry::SessionRegistry;

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
                        tokio::spawn(handle_connection(stream, reg));
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

/// Read newline-delimited JSON events from a single connection and dispatch
/// each to the registry. The connection is held open; multiple events can
/// arrive on the same stream.
async fn handle_connection(stream: UnixStream, registry: Arc<SessionRegistry>) {
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<SocketEvent>(&line) {
                    Ok(event) => dispatch_event(event, &registry).await,
                    Err(e) => {
                        tracing::warn!(error = %e, raw = %line, "failed to parse socket event");
                    }
                }
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

/// Route a parsed `SocketEvent` to the appropriate registry method.
async fn dispatch_event(event: SocketEvent, registry: &Arc<SessionRegistry>) {
    match event {
        SocketEvent::SessionStart {
            session_id,
            project,
            cwd,
            model,
            pid,
            branch,
            cc_session_id,
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
                rate_limit_utilization: None,
                rate_limit_type: None,
                total_cost_usd: None,
                model,
            };
            let inserted = registry.register_adhoc(session).await;
            tracing::info!(
                session_id = %session_id,
                inserted,
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
        } => {
            // Notification routing (TTS/APNs/banner) is out of scope for this
            // wave. Log it so operators can see it in traces.
            tracing::info!(
                %message,
                message_type = message_type.as_deref().unwrap_or("brief"),
                channels = ?channels,
                "socket: notification (unrouted)"
            );
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
            tracing::debug!(keys = ?payload.keys().collect::<Vec<_>>(), "socket: telemetry (unrouted)");
        }
    }
}
