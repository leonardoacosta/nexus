use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tonic::transport::{Channel, Endpoint};
use tracing::{debug, info, warn};

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
) -> mpsc::Receiver<StreamMessage> {
    let (tx, rx) = mpsc::channel::<StreamMessage>(256);
    let agents = agents.to_vec();
    let sid = session_id.clone();

    tokio::spawn(async move {
        info!(session_id = %sid, agent_count = agents.len(), "stream: subscribing to session events");
        for (host, port) in &agents {
            let endpoint = format!("http://{host}:{port}");
            debug!(%endpoint, session_id = %sid, "stream: attempting connection");
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

            if let Err(e) = run_session_stream(channel, &sid, &tx).await {
                warn!(%e, "stream: session stream ended");
            } else {
                debug!("stream: session stream ended cleanly (no more events)");
            }
            // If stream ends, we don't reconnect — the view will show
            // what was collected.
            return;
        }
        warn!("stream: could not connect to any agent for session stream");
    });

    rx
}

async fn run_session_stream(
    channel: Channel,
    session_id: &str,
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
        let _ = tx
            .send(StreamMessage::SessionMeta {
                session_type: session_type.to_string(),
                status: status.to_string(),
            })
            .await;

        let line = format!(
            "[now]    {} ACTIVE   project={} type={} pid={}",
            &session_id[..session_id.len().min(8)],
            project,
            session_type,
            session.pid,
        );
        let _ = tx
            .send(StreamMessage::Line(StreamLine {
                text: format!("── session snapshot ({status}) ──"),
            }))
            .await;
        let _ = tx
            .send(StreamMessage::Line(StreamLine { text: line }))
            .await;
        let _ = tx
            .send(StreamMessage::Line(StreamLine {
                text: "── live events ──".to_string(),
            }))
            .await;
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
                        .send(StreamMessage::Heartbeat { timestamp: ts })
                        .await
                        .is_err()
                    {
                        debug!("stream: receiver dropped (view closed)");
                        break;
                    }
                } else {
                    let line = format_event(&event);
                    if tx
                        .send(StreamMessage::Line(StreamLine { text: line }))
                        .await
                        .is_err()
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
