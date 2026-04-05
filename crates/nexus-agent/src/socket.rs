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
use nexus_core::config::{NotificationConfig, ProjectNotificationRules, Verbosity};
use nexus_core::lifecycle::{LifecycleEvent, project_from_cwd};
use nexus_core::session::{Session, SessionStatus};
use nexus_core::socket_event::{SocketCommand, SocketEvent, SocketResponse};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{RwLock, mpsc};
use tokio_util::sync::CancellationToken;

use crate::dispatch::dispatch_answer;
use crate::failures::{FailureBuffer, FailureEvent};
use crate::rate_limit_interceptor::{self, InterceptResult};
use crate::registry::SessionRegistry;
use crate::services::credential_pool::CredentialPool;
use crate::services::receiver::ReceiverService;
use nexus_core::db::{NexusDb, NotificationRecord as DbNotificationRecord};

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
            tokio::fs::remove_file(path).await?;
        }
    }

    Ok(())
}

/// URLs of peer agents to relay notifications to when this agent has role=agent.
/// e.g., `["http://macbook-pro:9999"]` — the primary's ReceiverService HTTP port.
/// Empty when role=primary (we handle notifications locally).
pub type PeerRelayUrls = Vec<String>;

/// Bundled context for the Unix socket service and per-connection handlers.
///
/// Replaces the 9-parameter signatures of `run_socket_service` and
/// `handle_connection` with a single shared struct.
pub struct SocketContext {
    pub registry: Arc<SessionRegistry>,
    pub receiver: Arc<ReceiverService>,
    pub cancel: CancellationToken,
    pub lifecycle_tx: Option<mpsc::Sender<LifecycleEvent>>,
    pub notification_config: Option<Arc<RwLock<NotificationConfig>>>,
    pub peer_relay_urls: PeerRelayUrls,
    pub failure_buffer: FailureBuffer,
    pub http_client: reqwest::Client,
    pub credential_pool: Arc<CredentialPool>,
    pub db: Arc<NexusDb>,
}

/// Bind the Unix domain socket and run the accept loop.
///
/// Exits when `cancel` is triggered. The socket file is removed on exit.
///
/// `lifecycle_tx`: if `Some`, lifecycle events (AgentSpawn, AgentComplete,
/// SessionStart, SessionStop) are forwarded to the NotificationEngine via this
/// channel. Pass `None` when running in `role = agent` mode.
///
/// `notification_config`: if `Some`, `notification_rules` and `notification_set`
/// socket commands are handled. Pass `None` when running in `role = agent` mode.
///
/// `peer_relay_urls`: when role=agent, Notification and DeployStatus events are
/// relayed via HTTP POST to these URLs (the primary's /speak endpoint).
pub async fn run_socket_service(ctx: SocketContext) -> Result<()> {
    let path = socket_path();

    let listener = UnixListener::bind(&path)?;
    tracing::info!(path = %path.display(), "socket listener bound");

    loop {
        tokio::select! {
            // Graceful shutdown requested.
            _ = ctx.cancel.cancelled() => {
                tracing::info!("socket service shutting down");
                break;
            }

            // New incoming connection.
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _addr)) => {
                        let reg = Arc::clone(&ctx.registry);
                        let recv = Arc::clone(&ctx.receiver);
                        let tx = ctx.lifecycle_tx.clone();
                        let notif_cfg = ctx.notification_config.clone();
                        let relay = ctx.peer_relay_urls.clone();
                        let failures = ctx.failure_buffer.clone();
                        let client = ctx.http_client.clone();
                        let pool = Arc::clone(&ctx.credential_pool);
                        let db = Arc::clone(&ctx.db);
                        tokio::spawn(handle_connection(stream, reg, recv, tx, notif_cfg, relay, failures, client, pool, db));
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
        if let Err(e) = tokio::fs::remove_file(&path).await {
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
    lifecycle_tx: Option<mpsc::Sender<LifecycleEvent>>,
    notification_config: Option<Arc<RwLock<NotificationConfig>>>,
    peer_relay_urls: PeerRelayUrls,
    failure_buffer: FailureBuffer,
    http_client: reqwest::Client,
    credential_pool: Arc<CredentialPool>,
    db: Arc<NexusDb>,
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
                    dispatch_event(
                        event,
                        &registry,
                        &receiver,
                        lifecycle_tx.as_ref(),
                        &peer_relay_urls,
                        &failure_buffer,
                        &http_client,
                        &credential_pool,
                        &db,
                    )
                    .await;
                    continue;
                }
                // Try SocketCommand (query/mutate — expects a JSON response)
                if let Ok(cmd) = serde_json::from_str::<SocketCommand>(&line) {
                    let response =
                        dispatch_command(cmd, &receiver, notification_config.as_ref()).await;
                    let mut response_line = serde_json::to_string(&response)
                        .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"));
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
///
/// `lifecycle_tx`: if `Some`, AgentSpawn, AgentComplete, SessionStart, and
/// SessionStop events are forwarded to the NotificationEngine.
async fn dispatch_event(
    event: SocketEvent,
    registry: &Arc<SessionRegistry>,
    receiver: &Arc<ReceiverService>,
    lifecycle_tx: Option<&mpsc::Sender<LifecycleEvent>>,
    peer_relay_urls: &[String],
    failure_buffer: &FailureBuffer,
    http_client: &reqwest::Client,
    credential_pool: &Arc<CredentialPool>,
    db: &Arc<NexusDb>,
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
            let cwd_str = cwd.clone().unwrap_or_default();
            let project_code = project
                .clone()
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| project_from_cwd(&cwd_str));
            let now = chrono::Utc::now();
            let session = Session {
                id: session_id.clone(),
                pid: pid.unwrap_or(0),
                project,
                cwd: cwd_str.clone(),
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
                model: model.clone(),
                session_type: nexus_core::session::SessionType::AdHoc,
            };
            let inserted = registry.register_adhoc(session, tmux_target.clone()).await;
            tracing::info!(
                session_id = %session_id,
                inserted,
                tmux_target = ?tmux_target,
                "socket: session_start"
            );
            if let Some(tx) = lifecycle_tx {
                let ev = LifecycleEvent::session_start(
                    "local",
                    project_code,
                    &session_id,
                    model,
                    cwd_str,
                );
                let _ = tx.send(ev).await;
            }
        }

        SocketEvent::SessionStop { session_id } => {
            let removed = registry.unregister(&session_id).await;
            tracing::info!(
                session_id = %session_id,
                removed,
                "socket: session_stop"
            );
            if let Some(tx) = lifecycle_tx {
                let ev = LifecycleEvent::session_stop("local", "", &session_id, 0);
                let _ = tx.send(ev).await;
            }
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
                relay_peers = peer_relay_urls.len(),
                "socket: notification"
            );

            // [4.1] Check for rate limit in notification text.
            if rate_limit_interceptor::is_rate_limit_notification(&message) {
                tracing::info!("socket: rate limit detected in notification text");
                let result = rate_limit_interceptor::handle_rate_limit(
                    credential_pool,
                    registry,
                    notif_session_id.as_deref(),
                )
                .await;
                match result {
                    // [4.4] Handled — suppress notification from TTS.
                    InterceptResult::Handled => {
                        // [5.2] Log suppressed notification.
                        let _ = db.insert_notification(&DbNotificationRecord {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            message: message.clone(),
                            message_type: message_type.clone(),
                            project: None,
                            channels: Some("tts".to_string()),
                            delivered: false,
                            suppressed: true,
                        });
                        return;
                    }
                    // [5.3] Exhausted — deliver exhaustion message via TTS.
                    InterceptResult::Exhausted(exhaustion_msg) => {
                        let tts_channels = vec!["tts".to_string()];
                        if peer_relay_urls.is_empty() {
                            if let Err(e) = receiver
                                .speak_from_socket(
                                    &exhaustion_msg,
                                    Some("brief"),
                                    Some(&tts_channels),
                                )
                                .await
                            {
                                tracing::warn!(error = %e, "socket: speak_from_socket failed (exhaustion)");
                            }
                        } else {
                            relay_notification_to_peers(
                                peer_relay_urls,
                                &exhaustion_msg,
                                Some("brief"),
                                Some(&tts_channels),
                                http_client,
                            )
                            .await;
                        }
                        return;
                    }
                    // NoPool — fall through to normal notification handling.
                    InterceptResult::NoPool => {}
                }
            }

            // Check if meeting is active — queue to batch buffer instead of delivering
            {
                let state = receiver.state().read().await;
                if state.is_meeting_active() {
                    // Queue for post-meeting delivery
                    use crate::services::receiver::QueuedNotification;
                    let notification = QueuedNotification {
                        message: message.clone(),
                        notification_type: message_type
                            .clone()
                            .unwrap_or_else(|| "background_tasks".to_string()),
                        project: None,
                        received_at: std::time::Instant::now(),
                    };
                    drop(state);
                    {
                        let mut state = receiver.state().write().await;
                        state.notification_batch.add(notification);
                    }

                    // Update DB record to show suppressed/queued
                    let _ = db.insert_notification(&DbNotificationRecord {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        message: message.clone(),
                        message_type: message_type.clone(),
                        project: None,
                        channels: Some("queued".to_string()),
                        delivered: false,
                        suppressed: true,
                    });

                    tracing::info!(
                        message = %message,
                        "Meeting active — notification queued for post-meeting delivery"
                    );
                    return;
                }
            }

            // Default channels to ["tts"] when not specified
            let effective_channels = channels.unwrap_or_else(|| vec!["tts".to_string()]);

            // [5.1] Log delivered notification to DB.
            let _ = db.insert_notification(&DbNotificationRecord {
                timestamp: chrono::Utc::now().to_rfc3339(),
                message: message.clone(),
                message_type: message_type.clone(),
                project: None,
                channels: Some(effective_channels.join(",")),
                delivered: true,
                suppressed: false,
            });

            if peer_relay_urls.is_empty() {
                // role=primary: handle locally via ReceiverService
                if let Err(e) = receiver
                    .speak_from_socket(&message, message_type.as_deref(), Some(&effective_channels))
                    .await
                {
                    tracing::warn!(error = %e, "socket: speak_from_socket failed (notification)");
                }
            } else {
                // role=agent: relay to primary peer(s) via HTTP
                relay_notification_to_peers(
                    peer_relay_urls,
                    &message,
                    message_type.as_deref(),
                    Some(&effective_channels),
                    http_client,
                )
                .await;
            }

            // Track pending questions regardless of role
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
                "socket: agent_spawn"
            );
            if let Some(tx) = lifecycle_tx {
                let agent_type_str = agent_type.unwrap_or_else(|| "unknown".to_string());
                // Find project from the active session if we have a session_id.
                let project = if let Some(ref sid) = session_id {
                    let all = registry.get_all().await;
                    all.into_iter()
                        .find(|s| &s.id == sid)
                        .and_then(|s| s.project)
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let ev = LifecycleEvent::agent_spawn("local", project, agent_type_str, model);
                let _ = tx.send(ev).await;
            }
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
                "socket: agent_complete"
            );
            if let Some(tx) = lifecycle_tx {
                let agent_type_str = agent_type.unwrap_or_else(|| "unknown".to_string());
                let project = if let Some(ref sid) = session_id {
                    let all = registry.get_all().await;
                    all.into_iter()
                        .find(|s| &s.id == sid)
                        .and_then(|s| s.project)
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let ev = LifecycleEvent::agent_complete(
                    "local",
                    project,
                    agent_type_str,
                    duration_ms.unwrap_or(0),
                    0,
                    0,
                );
                let _ = tx.send(ev).await;
            }
        }

        SocketEvent::Telemetry { payload } => {
            // Check if this is a tool_use_fail event and record it.
            let is_tool_fail = payload
                .get("type")
                .and_then(|v| v.as_str())
                .is_some_and(|t| t == "tool_use_fail");

            if is_tool_fail {
                let tool_name = payload
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let error_summary = payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error")
                    .to_string();
                let project = payload
                    .get("project")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let session_id = payload
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let event = FailureEvent {
                    timestamp: chrono::Utc::now(),
                    tool_name: tool_name.clone(),
                    error_summary: error_summary.clone(),
                    project: project.clone(),
                    session_id,
                };
                failure_buffer.push(event).await;
                tracing::info!(
                    tool = %tool_name,
                    project = %project,
                    error = %error_summary,
                    "socket: tool_use_fail recorded in failure buffer"
                );
            } else {
                // [4.1] Check for rate_limit_event with utilization >= 1.0 in telemetry.
                let is_rate_limit_exhausted = payload
                    .get("type")
                    .and_then(|v| v.as_str())
                    .is_some_and(|t| t == "rate_limit_event")
                    && payload
                        .get("rate_limit_info")
                        .and_then(|v| v.get("utilization"))
                        .and_then(|v| v.as_f64())
                        .is_some_and(|u| u >= 1.0);

                if is_rate_limit_exhausted {
                    let telemetry_session_id = payload
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    tracing::info!(
                        session_id = ?telemetry_session_id,
                        "socket: rate limit exhaustion detected in telemetry"
                    );
                    let result = rate_limit_interceptor::handle_rate_limit(
                        credential_pool,
                        registry,
                        telemetry_session_id.as_deref(),
                    )
                    .await;
                    if let InterceptResult::Exhausted(exhaustion_msg) = result {
                        // [5.3] Deliver exhaustion notification via TTS.
                        let tts_channels = vec!["tts".to_string()];
                        if peer_relay_urls.is_empty() {
                            if let Err(e) = receiver
                                .speak_from_socket(
                                    &exhaustion_msg,
                                    Some("brief"),
                                    Some(&tts_channels),
                                )
                                .await
                            {
                                tracing::warn!(error = %e, "socket: speak_from_socket failed (telemetry exhaustion)");
                            }
                        } else {
                            relay_notification_to_peers(
                                peer_relay_urls,
                                &exhaustion_msg,
                                Some("brief"),
                                Some(&tts_channels),
                                http_client,
                            )
                            .await;
                        }
                    }
                } else {
                    tracing::debug!(
                        keys = ?payload.keys().collect::<Vec<_>>(),
                        "socket: telemetry (unrouted)"
                    );
                }
            }
        }

        SocketEvent::SessionSummary {
            session_id,
            project,
            tool_counts,
            failure_count,
            compaction_count,
            agent_spawns,
            duration_ms,
            model,
        } => {
            tracing::info!(
                session_id = %session_id,
                project = ?project,
                tool_count = tool_counts.len(),
                failure_count,
                duration_ms,
                "socket: session_summary"
            );
            let summary = crate::registry::SessionSummaryData {
                tool_counts,
                failure_count,
                compaction_count,
                agent_spawns,
                duration_ms,
                model,
                session_id: session_id.clone(),
                project,
                received_at: chrono::Utc::now(),
            };
            registry.store_session_summary(summary).await;
        }

        SocketEvent::DeployStatus {
            project,
            status,
            message,
            target,
            service,
        } => {
            let target_str = target.as_deref().unwrap_or("local");
            let service_str = service.as_deref().unwrap_or("unknown");
            let msg = message.as_deref().unwrap_or("");

            tracing::info!(
                %project, %status, target = target_str, service = service_str,
                "socket: deploy_status"
            );

            let detail = if msg.is_empty() {
                format!("{} {} on {}", service_str, status, target_str)
            } else {
                msg.to_string()
            };
            let deploy_msg = format!("{} deploy: {}", project.to_uppercase(), detail);

            if peer_relay_urls.is_empty() {
                // role=primary: forward to notification engine
                if let Some(tx) = lifecycle_tx {
                    use nexus_core::lifecycle::LifecycleEventKind;
                    let _ = tx
                        .send(LifecycleEvent {
                            source_agent: target_str.to_string(),
                            project: project.clone(),
                            kind: LifecycleEventKind::Notification {
                                message: deploy_msg,
                                channels: vec!["tts".to_string()],
                                message_type: "brief".to_string(),
                            },
                        })
                        .await;
                }
            } else {
                // role=agent: relay to primary
                relay_notification_to_peers(
                    peer_relay_urls,
                    &deploy_msg,
                    Some("brief"),
                    Some(&["tts".to_string()]),
                    http_client,
                )
                .await;
            }
        }
    }
}

/// Relay a notification to peer agents via HTTP POST to their /speak endpoint.
/// Fire-and-forget — errors are logged but don't block.
async fn relay_notification_to_peers(
    peer_urls: &[String],
    message: &str,
    message_type: Option<&str>,
    channels: Option<&[String]>,
    client: &reqwest::Client,
) {
    let body = serde_json::json!({
        "message": message,
        "type": message_type.unwrap_or("brief"),
        "channels": channels.unwrap_or(&[]),
    });
    let body_str = body.to_string();

    for url in peer_urls {
        let speak_url = format!("{}/speak", url);
        let body_clone = body_str.clone();
        let client = client.clone();
        // Spawn per-peer to avoid blocking on slow/unreachable peers
        tokio::spawn(async move {
            match client
                .post(&speak_url)
                .header("content-type", "application/json")
                .body(body_clone)
                .send()
                .await
            {
                Ok(resp) => {
                    tracing::info!(
                        url = %speak_url,
                        status = %resp.status(),
                        "relay: notification forwarded to peer"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        url = %speak_url,
                        error = %e,
                        "relay: failed to forward notification to peer"
                    );
                }
            }
        });
    }
}

/// Execute a `SocketCommand` and return a typed `SocketResponse`.
async fn dispatch_command(
    cmd: SocketCommand,
    receiver: &Arc<ReceiverService>,
    notification_config: Option<&Arc<RwLock<NotificationConfig>>>,
) -> SocketResponse {
    match cmd {
        SocketCommand::ModeQuery => {
            tracing::debug!("socket: command mode_query");
            parse_response(receiver.mode_query_json())
        }
        SocketCommand::ModeSet { mode } => {
            tracing::info!(mode = %mode, "socket: command mode_set");
            parse_response(receiver.mode_set_json(&mode))
        }
        SocketCommand::ModeCycle => {
            tracing::info!("socket: command mode_cycle");
            parse_response(receiver.mode_cycle_json())
        }
        SocketCommand::History { limit } => {
            tracing::debug!(limit = ?limit, "socket: command history");
            let json_str = receiver.history_json(limit).await;
            match serde_json::from_str::<Vec<serde_json::Value>>(&json_str) {
                Ok(items) => SocketResponse::History(items),
                Err(_) => SocketResponse::History(Vec::new()),
            }
        }
        SocketCommand::TypeSet { name, mode } => {
            tracing::info!(type_name = %name, mode = %mode, "socket: command type_set");
            parse_response(receiver.type_set_json(&name, &mode))
        }
        SocketCommand::TypeClear { name } => {
            tracing::info!(type_name = %name, "socket: command type_clear");
            parse_response(receiver.type_clear_json(&name))
        }
        SocketCommand::NotificationRules { project } => {
            tracing::debug!(project = %project, "socket: command notification_rules");
            let json_str = handle_notification_rules(&project, notification_config).await;
            parse_response(json_str)
        }
        SocketCommand::NotificationSet {
            project,
            verbosity,
            announce_agents,
            announce_specs,
            announce_sessions,
            reset_to_default,
        } => {
            tracing::info!(
                project = %project,
                verbosity = ?verbosity,
                announce_agents = ?announce_agents,
                announce_specs = ?announce_specs,
                announce_sessions = ?announce_sessions,
                reset_to_default,
                "socket: command notification_set"
            );
            parse_response(
                handle_notification_set(
                    &project,
                    verbosity.as_deref(),
                    announce_agents,
                    announce_specs,
                    announce_sessions,
                    reset_to_default,
                    notification_config,
                )
                .await,
            )
        }
    }
}

/// Parse a JSON string from a receiver method into a `SocketResponse`.
///
/// Falls back to `SocketResponse::Error` if the string cannot be parsed as
/// any known variant.
fn parse_response(json_str: String) -> SocketResponse {
    serde_json::from_str::<SocketResponse>(&json_str).unwrap_or_else(|_| {
        // Try as a generic JSON value and wrap it.
        match serde_json::from_str::<serde_json::Value>(&json_str) {
            Ok(val) => SocketResponse::Rules(val),
            Err(e) => SocketResponse::Error {
                error: format!("parse error: {e}"),
            },
        }
    })
}

/// Return the effective rules for `project` as a JSON string.
async fn handle_notification_rules(
    project: &str,
    notification_config: Option<&Arc<RwLock<NotificationConfig>>>,
) -> String {
    let Some(cfg_lock) = notification_config else {
        return serde_json::json!({"error": "notification config not available (role=agent)"})
            .to_string();
    };
    let cfg = cfg_lock.read().await;
    let rules = cfg.rules_for(project);
    match serde_json::to_string(rules) {
        Ok(json) => json,
        Err(e) => serde_json::json!({"error": format!("serialize error: {e}")}).to_string(),
    }
}

/// Mutate per-project notification rules and persist to TOML.
async fn handle_notification_set(
    project: &str,
    verbosity_str: Option<&str>,
    announce_agents: Option<bool>,
    announce_specs: Option<bool>,
    announce_sessions: Option<bool>,
    reset_to_default: bool,
    notification_config: Option<&Arc<RwLock<NotificationConfig>>>,
) -> String {
    let Some(cfg_lock) = notification_config else {
        return serde_json::json!({"error": "notification config not available (role=agent)"})
            .to_string();
    };

    let mut cfg = cfg_lock.write().await;

    if project.is_empty() {
        // Mutate the [defaults] section.
        apply_rule_mutations(
            &mut cfg.defaults,
            verbosity_str,
            announce_agents,
            announce_specs,
            announce_sessions,
        );
    } else if reset_to_default {
        // Remove the project override entirely.
        cfg.projects.remove(project);
    } else {
        // Clone defaults first to avoid a borrow conflict when using entry API.
        let defaults_clone = cfg.defaults.clone();
        let entry = cfg
            .projects
            .entry(project.to_string())
            .or_insert_with(|| defaults_clone);
        apply_rule_mutations(
            entry,
            verbosity_str,
            announce_agents,
            announce_specs,
            announce_sessions,
        );
    }

    // Persist to disk. The hot-reload watcher will pick this up on the engine
    // side — we also update the in-memory arc directly above.
    if let Err(e) = cfg.save() {
        tracing::warn!("socket: notification_set save failed: {e}");
        return serde_json::json!({"error": format!("save failed: {e}")}).to_string();
    }

    serde_json::json!({"ok": true, "project": project}).to_string()
}

/// Apply field-level mutations to a `ProjectNotificationRules`.
fn apply_rule_mutations(
    rules: &mut ProjectNotificationRules,
    verbosity_str: Option<&str>,
    announce_agents: Option<bool>,
    announce_specs: Option<bool>,
    announce_sessions: Option<bool>,
) {
    if let Some(v) = verbosity_str {
        rules.verbosity = match v {
            "verbose" => Verbosity::Verbose,
            "silent" => Verbosity::Silent,
            _ => Verbosity::Brief,
        };
    }
    if let Some(v) = announce_agents {
        rules.announce_agents = v;
    }
    if let Some(v) = announce_specs {
        rules.announce_specs = v;
    }
    if let Some(v) = announce_sessions {
        rules.announce_sessions = v;
    }
}
