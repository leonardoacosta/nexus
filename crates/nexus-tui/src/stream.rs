use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tonic::transport::{Channel, Endpoint};
use tracing::{debug, info, warn};

/// Maximum number of reconnection attempts before giving up.
const MAX_RECONNECT_ATTEMPTS: u32 = 5;

/// Bounded channel capacity for session stream messages.
/// Keeps memory bounded when the TUI render loop is slower than the stream.
const STREAM_CHANNEL_CAPACITY: usize = 64;

use nexus_core::proto::nexus_agent_client::NexusAgentClient;
use nexus_core::proto::{EventFilter, SessionEvent, SessionId};

/// A formatted event line received from the stream.
#[derive(Debug, Clone)]
pub struct StreamLine {
    pub text: String,
}

/// A message sent from the background stream task to the main event loop.
#[derive(Debug, Clone)]
pub enum StreamMessage {
    /// A regular log line.
    Line(StreamLine),
    /// Initial session metadata, sent once after the snapshot fetch.
    SessionMeta {
        session_type: String,
        /// Current session status string (e.g. "Active", "Idle"). Carried for
        /// future use; not yet displayed in the TUI.
        #[allow(dead_code)]
        status: String,
    },
    /// Heartbeat signal — not displayed as a log line.
    Heartbeat {
        timestamp: String, // HH:MM:SS format
    },
    /// The agent signalled it is shutting down (GoingAway event).
    AgentGoingAway { agent_name: String, reason: String },
    /// The stream could not be re-established after `MAX_RECONNECT_ATTEMPTS`.
    Disconnected { reason: String },
}

/// A notification-worthy event detected from the background alert stream.
#[derive(Debug, Clone)]
pub struct AlertEvent {
    pub session_id: String,
    /// Proto status value (3 = Stale, 4 = Errored).
    pub new_status: i32,
}

/// Subscribe to StreamEvents for a specific session and forward formatted
/// lines into the returned receiver.
///
/// The spawned task runs until the receiver is dropped.
pub fn subscribe_session_stream(
    agents: &[(String, u16)], // (host, port) pairs
    session_id: String,
    agent_name: String,
) -> mpsc::Receiver<StreamMessage> {
    // Task 1.6: Use named bounded capacity to avoid blocking the stream task.
    let (tx, rx) = mpsc::channel::<StreamMessage>(STREAM_CHANNEL_CAPACITY);
    let agents = agents.to_vec();
    let sid = session_id.clone();
    let aname = agent_name.clone();

    tokio::spawn(async move {
        info!(session_id = %sid, agent_count = agents.len(), "stream: subscribing to session events");

        // Task 1.3: Retry loop with exponential backoff.
        // Back-off: min(2^attempt, 30) seconds, up to MAX_RECONNECT_ATTEMPTS.
        let mut attempt: u32 = 0;

        loop {
            let mut connected = false;

            for (host, port) in &agents {
                let endpoint = format!("http://{host}:{port}");
                debug!(%endpoint, session_id = %sid, attempt, "stream: attempting connection");
                let channel = match Endpoint::from_shared(endpoint.clone()) {
                    Ok(ep) => match ep
                        .connect_timeout(std::time::Duration::from_secs(2))
                        .connect()
                        .await
                    {
                        Ok(ch) => {
                            info!(%endpoint, "stream: connected successfully");
                            ch
                        }
                        Err(e) => {
                            warn!(%endpoint, %e, "stream: failed to connect");
                            continue;
                        }
                    },
                    Err(e) => {
                        warn!(%endpoint, %e, "stream: invalid endpoint");
                        continue;
                    }
                };

                connected = true;
                if let Err(e) = run_session_stream(channel, &sid, &aname, &tx).await {
                    warn!(%e, attempt, "stream: session stream ended with error");
                } else {
                    debug!(attempt, "stream: session stream ended cleanly (no more events)");
                }
                break;
            }

            if !connected {
                warn!(attempt, "stream: could not connect to any agent");
            }

            attempt += 1;
            if attempt > MAX_RECONNECT_ATTEMPTS {
                let reason = format!("stream disconnected after {MAX_RECONNECT_ATTEMPTS} attempts");
                warn!(%reason, "stream: giving up");
                let _ = tx.send(StreamMessage::Disconnected { reason }).await;
                return;
            }

            // Exponential back-off: min(2^attempt, 30) seconds.
            let backoff_secs = (1u64 << attempt).min(30);
            warn!(attempt, backoff_secs, "stream: will retry after backoff");
            tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
        }
    });

    rx
}

async fn run_session_stream(
    channel: Channel,
    session_id: &str,
    agent_name: &str,
    tx: &mpsc::Sender<StreamMessage>,
) -> anyhow::Result<()> {
    let mut client = NexusAgentClient::new(channel);
    let request = tonic::Request::new(EventFilter {
        session_id: Some(session_id.to_string()),
        event_types: vec![],
        initial_snapshot: false,
    });

    // Fetch current session state to show immediately (before waiting for events).
    let snapshot_request = tonic::Request::new(SessionId {
        id: session_id.to_string(),
    });
    if let Ok(response) = client.get_session(snapshot_request).await {
        let session = response.into_inner();
        let project = session.project.as_deref().unwrap_or("-");
        let status = status_name(session.status);
        let session_type = if session.tmux_session.is_some() {
            "managed"
        } else {
            "ad-hoc"
        };

        // Send session metadata so the title bar can display a type badge.
        // Task 1.6: Use try_send (drop-oldest pattern) to avoid blocking.
        let _ = tx.try_send(StreamMessage::SessionMeta {
            session_type: session_type.to_string(),
            status: status.to_string(),
        });

        let line = format!(
            "[now]    {} ACTIVE   project={} type={} pid={}",
            &session_id[..session_id.len().min(8)],
            project,
            session_type,
            session.pid,
        );
        let _ = tx.try_send(StreamMessage::Line(StreamLine {
            text: format!("── session snapshot ({status}) ──"),
        }));
        let _ = tx.try_send(StreamMessage::Line(StreamLine { text: line }));
        let _ = tx.try_send(StreamMessage::Line(StreamLine {
            text: "── live events ──".to_string(),
        }));
    }

    debug!(%session_id, "stream: calling StreamEvents RPC");
    let response = client.stream_events(request).await?;
    info!(%session_id, "stream: RPC connected, waiting for events");
    let mut stream = response.into_inner();
    let mut event_count: u64 = 0;

    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                event_count += 1;
                let is_heartbeat = matches!(
                    &event.payload,
                    Some(nexus_core::proto::session_event::Payload::Heartbeat(_))
                );
                debug!(
                    %session_id,
                    event_count,
                    is_heartbeat,
                    "stream: received event"
                );

                if is_heartbeat {
                    // Extract the heartbeat timestamp and send as a Heartbeat message
                    // (no log line emitted — title bar indicator handles display).
                    // Task 1.6: try_send drops the message when buffer is full rather than blocking.
                    let ts = event
                        .ts
                        .as_ref()
                        .map(|t| {
                            chrono::DateTime::from_timestamp(t.seconds, t.nanos as u32)
                                .map(|dt| dt.format("%H:%M:%S").to_string())
                                .unwrap_or_else(|| "??:??:??".to_string())
                        })
                        .unwrap_or_else(|| "??:??:??".to_string());
                    if tx.try_send(StreamMessage::Heartbeat { timestamp: ts }).is_err()
                        && tx.is_closed()
                    {
                        debug!("stream: receiver dropped (view closed)");
                        break;
                    }
                } else if let Some(nexus_core::proto::session_event::Payload::GoingAway(g)) =
                    &event.payload
                {
                    // Agent is shutting down — signal the TUI to begin reconnecting.
                    let reason = g.reason.clone();
                    let _ = tx.try_send(StreamMessage::AgentGoingAway {
                        agent_name: agent_name.to_string(),
                        reason: reason.clone(),
                    });
                    // Also emit a log line so the user can see it in the stream view.
                    let line = format_event(&event);
                    let _ = tx.try_send(StreamMessage::Line(StreamLine { text: line }));
                    // Stream will end shortly as the agent shuts down; stop reading.
                    break;
                } else {
                    let line = format_event(&event);
                    if tx.try_send(StreamMessage::Line(StreamLine { text: line })).is_err()
                        && tx.is_closed()
                    {
                        debug!("stream: receiver dropped (view closed)");
                        break;
                    }
                }
            }
            Err(e) => {
                warn!(%e, "stream: error receiving event");
                break;
            }
        }
    }

    info!(%session_id, event_count, "stream: stream ended");
    Ok(())
}

/// Subscribe to StreamEvents (unfiltered) across all agents for alert
/// notifications. Only forwards StatusChanged events for Stale/Errored.
pub fn subscribe_alert_stream(agents: &[(String, u16)]) -> mpsc::Receiver<AlertEvent> {
    let (tx, rx) = mpsc::channel::<AlertEvent>(64);
    let agents = agents.to_vec();

    tokio::spawn(async move {
        for (host, port) in &agents {
            let endpoint = format!("http://{host}:{port}");
            let channel = match Endpoint::from_shared(endpoint.clone()) {
                Ok(ep) => match ep
                    .connect_timeout(std::time::Duration::from_secs(2))
                    .connect()
                    .await
                {
                    Ok(ch) => ch,
                    Err(e) => {
                        warn!(%endpoint, %e, "alerts: failed to connect");
                        continue;
                    }
                },
                Err(e) => {
                    warn!(%endpoint, %e, "alerts: invalid endpoint");
                    continue;
                }
            };

            let tx_clone = tx.clone();
            tokio::spawn(async move {
                if let Err(e) = run_alert_stream(channel, &tx_clone).await {
                    warn!(%e, "alerts: stream ended");
                }
            });
        }
        // Keep running — the spawned per-agent tasks hold tx clones.
        // This task just exits; the spawned tasks keep the channel alive.
    });

    rx
}

async fn run_alert_stream(channel: Channel, tx: &mpsc::Sender<AlertEvent>) -> anyhow::Result<()> {
    let mut client = NexusAgentClient::new(channel);
    let request = tonic::Request::new(EventFilter {
        session_id: None,
        event_types: vec![],
        initial_snapshot: false,
    });

    let response = client.stream_events(request).await?;
    let mut stream = response.into_inner();

    while let Some(result) = stream.next().await {
        match result {
            Ok(event) => {
                // Only care about StatusChanged to Stale (3) or Errored (4).
                if let Some(nexus_core::proto::session_event::Payload::StatusChanged(sc)) =
                    &event.payload
                {
                    let new_status = sc.new_status;
                    if new_status == 3 || new_status == 4 {
                        let alert = AlertEvent {
                            session_id: event.session_id.clone(),
                            new_status,
                        };
                        if tx.send(alert).await.is_err() {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                warn!(%e, "alerts: error receiving event");
                break;
            }
        }
    }

    Ok(())
}

/// Format a SessionEvent into a human-readable log line.
fn format_event(event: &SessionEvent) -> String {
    let ts = event
        .ts
        .as_ref()
        .map(|t| {
            chrono::DateTime::from_timestamp(t.seconds, t.nanos as u32)
                .map(|dt| dt.format("%H:%M:%S").to_string())
                .unwrap_or_else(|| "??:??:??".to_string())
        })
        .unwrap_or_else(|| "??:??:??".to_string());

    let sid_short = &event.session_id[..event.session_id.len().min(8)];

    match &event.payload {
        Some(nexus_core::proto::session_event::Payload::Started(s)) => {
            let project = s
                .session
                .as_ref()
                .and_then(|sess| sess.project.clone())
                .unwrap_or_else(|| "-".to_string());
            format!("[{ts}] {sid_short} STARTED  project={project}")
        }
        Some(nexus_core::proto::session_event::Payload::Heartbeat(h)) => {
            let hb_ts = h
                .last_heartbeat
                .as_ref()
                .map(|t| {
                    chrono::DateTime::from_timestamp(t.seconds, t.nanos as u32)
                        .map(|dt| dt.format("%H:%M:%S").to_string())
                        .unwrap_or_else(|| "?".to_string())
                })
                .unwrap_or_else(|| "?".to_string());
            format!("[{ts}] {sid_short} HEARTBEAT last={hb_ts}")
        }
        Some(nexus_core::proto::session_event::Payload::StatusChanged(sc)) => {
            let old = status_name(sc.old_status);
            let new = status_name(sc.new_status);
            format!("[{ts}] {sid_short} STATUS   {old} -> {new}")
        }
        Some(nexus_core::proto::session_event::Payload::Stopped(s)) => {
            format!("[{ts}] {sid_short} STOPPED  reason={}", s.reason)
        }
        Some(nexus_core::proto::session_event::Payload::GoingAway(g)) => {
            format!(
                "[{ts}] {sid_short} GOING_AWAY reason={} drain={}ms",
                g.reason, g.drain_timeout_ms
            )
        }
        None => {
            format!("[{ts}] {sid_short} UNKNOWN")
        }
    }
}

fn status_name(value: i32) -> &'static str {
    match value {
        1 => "Active",
        2 => "Idle",
        3 => "Stale",
        4 => "Errored",
        _ => "Unknown",
    }
}
