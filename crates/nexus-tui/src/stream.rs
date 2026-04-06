use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tonic::transport::{Channel, Endpoint};
use tracing::{debug, info, warn};

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
    /// The stream task stopped (receiver dropped or manual disconnect).
    /// Kept for future use; handled in the event loop but no longer emitted by
    /// the infinite-backoff task (which never gives up).
    #[allow(dead_code)]
    Disconnected { reason: String },
    /// Task 3.3: Reconnect state update — emitted by the reconnect loop so the
    /// stream view header can show "Reconnecting (attempt N, retry in Xs)".
    ReconnectState {
        attempt: u32,
        /// Seconds until the next reconnect attempt.
        next_try_secs: u64,
    },
    /// Stream successfully reconnected after one or more failed attempts.
    ReconnectSucceeded,
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

        // Task 3.1/3.2: Infinite reconnect loop with exponential backoff.
        // Back-off: 1 s base, 2× multiplier, capped at 120 s. No max attempt count.
        let mut attempt: u32 = 0;

        loop {
            // Apply exponential backoff before retrying (skip on first attempt).
            if attempt > 0 {
                let backoff_secs = (1u64 << attempt.min(7)).min(120);
                warn!(attempt, backoff_secs, "stream: will retry after backoff");
                // Task 3.3: Emit reconnect state so the stream view can show status.
                let _ = tx.try_send(StreamMessage::ReconnectState {
                    attempt,
                    next_try_secs: backoff_secs,
                });
                tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)).await;
            }

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
                if attempt > 0 {
                    // Notify the UI that the stream reconnected.
                    let _ = tx.try_send(StreamMessage::ReconnectSucceeded);
                }
                attempt = 0; // Reset backoff on successful connection.
                if let Err(e) = run_session_stream(channel, &sid, &aname, &tx).await {
                    warn!(%e, "stream: session stream ended with error");
                } else {
                    debug!("stream: session stream ended cleanly (no more events)");
                }
                break;
            }

            if !connected {
                warn!(attempt, "stream: could not connect to any agent");
                attempt += 1;
            } else {
                // Stream ended without error — increment to apply a short reconnect delay.
                attempt += 1;
            }

            // If the receiver has been dropped, stop the task.
            if tx.is_closed() {
                debug!("stream: receiver dropped, stopping reconnect loop");
                return;
            }
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
                    if tx
                        .try_send(StreamMessage::Heartbeat { timestamp: ts })
                        .is_err()
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
                    if tx
                        .try_send(StreamMessage::Line(StreamLine { text: line }))
                        .is_err()
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

/// Status of the alert stream connection for a single agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlertStreamStatus {
    Connected,
    Reconnecting {
        attempt: u32,
        next_try_secs: u64,
    },
    /// Receiver dropped — channel closed.
    #[allow(dead_code)]
    Stopped,
}

/// A message from the alert stream task — either an alert event or a status update.
#[derive(Debug, Clone)]
pub enum AlertMessage {
    Alert(AlertEvent),
    /// Status update for the named agent's alert stream.
    Status {
        agent: String,
        status: AlertStreamStatus,
    },
}

/// Subscribe to StreamEvents (unfiltered) across all agents for alert
/// notifications. Only forwards StatusChanged events for Stale/Errored.
///
/// Task 2.1: Each per-agent task now runs an infinite reconnect loop with
/// exponential backoff (1 s base, 2×, capped at 60 s).
pub fn subscribe_alert_stream(agents: &[(String, u16)]) -> mpsc::Receiver<AlertMessage> {
    let (tx, rx) = mpsc::channel::<AlertMessage>(128);
    let agents = agents.to_vec();

    for (host, port) in agents {
        let tx_clone = tx.clone();
        let endpoint = format!("http://{host}:{port}");
        tokio::spawn(async move {
            let agent_label = format!("{host}:{port}");
            let mut attempt: u32 = 0;
            loop {
                // Report reconnecting status (skip on first attempt).
                if attempt > 0 {
                    let next_try_secs = (1u64 << attempt.min(6)).min(60);
                    let status_msg = AlertMessage::Status {
                        agent: agent_label.clone(),
                        status: AlertStreamStatus::Reconnecting {
                            attempt,
                            next_try_secs,
                        },
                    };
                    if tx_clone.send(status_msg).await.is_err() {
                        return; // receiver dropped
                    }
                    warn!(agent = %agent_label, attempt, next_try_secs, "alerts: reconnecting");
                    tokio::time::sleep(std::time::Duration::from_secs(
                        (1u64 << attempt.min(6)).min(60),
                    ))
                    .await;
                }

                let channel = match tonic::transport::Endpoint::from_shared(endpoint.clone()) {
                    Ok(ep) => match ep
                        .connect_timeout(std::time::Duration::from_secs(2))
                        .connect()
                        .await
                    {
                        Ok(ch) => ch,
                        Err(e) => {
                            warn!(%endpoint, %e, attempt, "alerts: failed to connect");
                            attempt += 1;
                            continue;
                        }
                    },
                    Err(e) => {
                        warn!(%endpoint, %e, "alerts: invalid endpoint");
                        attempt += 1;
                        continue;
                    }
                };

                // Task 2.2: Report Connected status.
                let connected_msg = AlertMessage::Status {
                    agent: agent_label.clone(),
                    status: AlertStreamStatus::Connected,
                };
                if tx_clone.send(connected_msg).await.is_err() {
                    return;
                }
                attempt = 0;

                match run_alert_stream_msg(channel, &agent_label, &tx_clone).await {
                    Ok(()) => {
                        debug!(agent = %agent_label, "alerts: stream ended cleanly");
                    }
                    Err(e) => {
                        warn!(agent = %agent_label, %e, "alerts: stream ended with error");
                    }
                }
                attempt += 1;
            }
        });
    }

    rx
}

/// Run a single alert stream session, forwarding events as `AlertMessage::Alert`.
async fn run_alert_stream_msg(
    channel: Channel,
    agent_label: &str,
    tx: &mpsc::Sender<AlertMessage>,
) -> anyhow::Result<()> {
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
                        if tx.send(AlertMessage::Alert(alert)).await.is_err() {
                            return Ok(());
                        }
                    }
                }
            }
            Err(e) => {
                warn!(agent = %agent_label, %e, "alerts: error receiving event");
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
