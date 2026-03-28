//! EventForwarder — subscribes to peer agents' gRPC event streams and converts
//! the incoming `SessionEvent` protos into `LifecycleEvent` values that feed the
//! `NotificationEngine`.
//!
//! Only started when `role = primary`. For each non-self agent in agents.toml the
//! forwarder spawns an independent subscription task. Each task reconnects
//! automatically with a 30-second backoff on disconnect or error.

use std::time::Duration;

use nexus_core::config::AgentConfig;
use nexus_core::lifecycle::{LifecycleEvent, project_from_cwd};
use nexus_core::proto::nexus_agent_client::NexusAgentClient;
use nexus_core::proto::{EventFilter, session_event};
use tokio::sync::mpsc;

/// Subscribes to all peer agents and forwards their events as `LifecycleEvent`.
pub struct EventForwarder {
    /// Peer agents to subscribe to (does not include self).
    peers: Vec<AgentConfig>,
}

impl EventForwarder {
    /// Create a new forwarder for the given list of peer agents.
    pub fn new(peers: Vec<AgentConfig>) -> Self {
        Self { peers }
    }

    /// Spawn one background task per peer. Each task streams events and sends them
    /// as `LifecycleEvent` on `notification_tx`. Reconnects every 30 seconds on failure.
    pub fn spawn(self, notification_tx: mpsc::Sender<LifecycleEvent>) {
        for peer in self.peers {
            let tx = notification_tx.clone();
            tokio::spawn(async move {
                loop {
                    tracing::info!(peer = %peer.name, "event_forwarder: connecting to peer");
                    match subscribe_to_peer(&peer, &tx).await {
                        Ok(()) => {
                            tracing::info!(
                                peer = %peer.name,
                                "event_forwarder: peer stream ended, reconnecting in 30s"
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                peer = %peer.name,
                                error = %e,
                                "event_forwarder: peer error, reconnecting in 30s"
                            );
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });
        }
    }
}

/// Connect to a single peer's gRPC endpoint and stream events until the connection
/// is closed or an error occurs.
async fn subscribe_to_peer(
    peer: &AgentConfig,
    tx: &mpsc::Sender<LifecycleEvent>,
) -> Result<(), anyhow::Error> {
    let endpoint = format!("http://{}:{}", peer.host, peer.port);
    let mut client = NexusAgentClient::connect(endpoint).await?;

    let request = EventFilter {
        session_id: None,
        event_types: vec![],
        initial_snapshot: false,
    };

    let mut stream = client.stream_events(request).await?.into_inner();

    while let Some(event) = stream.message().await? {
        if let Some(lifecycle_event) = session_event_to_lifecycle(&peer.name, &event) {
            if tx.send(lifecycle_event).await.is_err() {
                // Receiver dropped — no point continuing.
                tracing::debug!(
                    peer = %peer.name,
                    "event_forwarder: notification channel closed, stopping subscription"
                );
                return Ok(());
            }
        }
    }

    Ok(())
}

/// Convert a gRPC `SessionEvent` proto into a `LifecycleEvent`.
///
/// - `Payload::Started` → `SessionStart`
/// - `Payload::Stopped` → `SessionStop`
/// - `Payload::Heartbeat` → `None` (suppressed)
/// - `Payload::StatusChanged` → `None` (suppressed)
/// - `Payload::GoingAway` → `None` (suppressed)
fn session_event_to_lifecycle(
    source_agent: &str,
    event: &nexus_core::proto::SessionEvent,
) -> Option<LifecycleEvent> {
    match &event.payload {
        Some(session_event::Payload::Started(started)) => {
            let session = started.session.as_ref()?;
            let cwd = session.cwd.clone();
            let project = if let Some(ref p) = session.project {
                if p.is_empty() {
                    project_from_cwd(&cwd)
                } else {
                    p.clone()
                }
            } else {
                project_from_cwd(&cwd)
            };
            let model = session.telemetry.as_ref().and_then(|t| t.model.clone());
            Some(LifecycleEvent::session_start(
                source_agent,
                project,
                &event.session_id,
                model,
                cwd,
            ))
        }
        Some(session_event::Payload::Stopped(_stopped)) => {
            // Duration is not available from the proto directly; pass 0.
            Some(LifecycleEvent::session_stop(
                source_agent,
                "",
                &event.session_id,
                0,
            ))
        }
        // Heartbeat and StatusChanged are high-frequency internal events; suppress.
        Some(session_event::Payload::Heartbeat(_))
        | Some(session_event::Payload::StatusChanged(_))
        | Some(session_event::Payload::GoingAway(_))
        | None => None,
    }
}
