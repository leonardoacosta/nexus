//! TTS Receiver HTTP service — thin orchestrator
//!
//! Provides the ReceiverService struct, constructors, and Service trait impls.
//! Handler logic lives in sub-modules:
//! - `types` — Public request/response types, constants
//! - `state` — ReceiverState, mode/type management, message store, buffer flush
//! - `http_router` — Axum router builder and HTTP request dispatch
//! - `delivery` — TTS, APNs, banner, iMessage delivery

use super::{PlaybackMessage, PlaybackQueue};
use super::http_router::build_receiver_router;
use crate::config::NotificationsConfig;
use crate::services::Service;
use crate::services::receiver::state::ReceiverState;
use anyhow::Result;
use chrono::Utc;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{RwLock, mpsc};
use tracing::{info, warn};

// Re-export types from the types module so existing imports continue to work.
pub use super::types::*;

// ---------------------------------------------------------------------------
// ReceiverService — struct + constructors + Service trait impls
// ---------------------------------------------------------------------------

/// TTS Receiver HTTP service
pub struct ReceiverService {
    port: u16,
    bind_address: String,
    state: Arc<RwLock<ReceiverState>>,
    config: NotificationsConfig,
}

impl ReceiverService {
    pub fn new() -> Self {
        let config = NotificationsConfig::load_sync().unwrap_or_default();
        Self::with_config(config)
    }

    pub fn with_config(config: NotificationsConfig) -> Self {
        let port = config.server.port;
        Self {
            port,
            bind_address: "127.0.0.1".to_string(),
            state: Arc::new(RwLock::new(ReceiverState::new(config.clone()))),
            config,
        }
    }

    pub fn with_port(port: u16) -> Self {
        let mut config = NotificationsConfig::load_sync().unwrap_or_default();
        config.server.port = port;
        Self::with_config(config)
    }

    /// Set the bind address for this receiver service.
    pub fn with_bind_address(mut self, bind_address: String) -> Self {
        self.bind_address = bind_address;
        self
    }

    /// Access the shared state (used by state.rs for history_json).
    pub(crate) fn state(&self) -> &Arc<RwLock<ReceiverState>> {
        &self.state
    }

    /// Route a notification through the full speak pipeline via socket.
    pub async fn speak_from_socket(
        &self,
        message: &str,
        message_type: Option<&str>,
        channels: Option<&[String]>,
    ) {
        let mut map = serde_json::Map::new();
        map.insert(
            "message".into(),
            serde_json::Value::String(message.to_string()),
        );
        if let Some(mt) = message_type {
            map.insert(
                "message_type".into(),
                serde_json::Value::String(mt.to_string()),
            );
        }
        if let Some(chs) = channels {
            let ch_vals: Vec<serde_json::Value> = chs
                .iter()
                .map(|c| serde_json::Value::String(c.clone()))
                .collect();
            map.insert("channels".into(), serde_json::Value::Array(ch_vals));
        }
        let body = match serde_json::to_vec(&serde_json::Value::Object(map)) {
            Ok(b) => b,
            Err(e) => {
                warn!("speak_from_socket: failed to serialize request: {}", e);
                return;
            }
        };
        let (status, _, _) =
            Self::handle_request("POST", "/speak", &body, Arc::clone(&self.state)).await;
        if status >= 400 {
            warn!(
                "speak_from_socket: handle_request returned status {}",
                status
            );
        }
    }
}

impl Default for ReceiverService {
    fn default() -> Self {
        Self::new()
    }
}

/// Allow `spawn_service(Arc::clone(&receiver), ...)` so main.rs can keep an
/// Arc reference to forward socket notifications without cloning the whole service.
#[async_trait::async_trait]
impl Service for Arc<ReceiverService> {
    fn name(&self) -> &'static str {
        "tts_receiver"
    }

    async fn start(&self, shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        ReceiverService::start(self, shutdown_rx).await
    }

    async fn health_check(&self) -> bool {
        ReceiverService::health_check(self).await
    }
}

#[async_trait::async_trait]
impl Service for ReceiverService {
    fn name(&self) -> &'static str {
        "tts_receiver"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        // Crash recovery: reset meeting/focus state to prevent stale detection
        // from a previous run blocking notifications on startup.
        {
            let mut state = self.state.write().await;
            state.set_meeting_active(false);
            state.notification_batch.set_focus_session(false);
            tracing::debug!("Reset meeting/focus state on startup (crash recovery)");
        }

        let addr: SocketAddr = format!("{}:{}", self.bind_address, self.port)
            .parse()
            .map_err(|e| {
                anyhow::anyhow!(
                    "invalid bind address '{}:{}': {}",
                    self.bind_address,
                    self.port,
                    e
                )
            })?;
        let listener = tokio::net::TcpListener::bind(addr).await?;

        info!(
            "TTS Receiver listening on http://{}:{}",
            self.bind_address, self.port
        );

        let queue_depth = self.config.playback_queue.max_depth;
        let (queue_handle, queue_join) =
            PlaybackQueue::spawn(self.config.clone(), Arc::clone(&self.state), queue_depth);
        info!("Playback queue spawned (depth={})", queue_depth);

        {
            let mut state = self.state.write().await;
            state.running = true;
            state.started_at = Some(Utc::now());
            state.playback_queue = Some(queue_handle);
        }

        // Meeting detection polling — bridges suppression → focus_session → flush
        let meeting_state = Arc::clone(&self.state);
        let meeting_poll_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.tick().await; // skip first immediate tick

            loop {
                interval.tick().await;

                // Acquire write lock to check and mutate meeting state.
                // `suppression_checker.is_meeting_active()` requires `&mut self`.
                let transition = {
                    let mut state = meeting_state.write().await;
                    let was_active = state.is_meeting_active();
                    let is_active = state.suppression_checker.is_meeting_active().await;

                    if is_active && !was_active {
                        // Entered meeting — activate focus session
                        info!("Meeting detected — activating notification queue");
                        state.set_meeting_active(true);
                        state.notification_batch.set_focus_session(true);
                        None
                    } else if !is_active && was_active {
                        // Left meeting — deactivate and flush
                        info!("Meeting ended — flushing queued notifications");
                        state.set_meeting_active(false);
                        state.notification_batch.set_focus_session(false);

                        let summary = state.notification_batch.flush_as_summary();
                        let queue = state.playback_queue.clone();
                        // Return data so we can drop the lock before TTS delivery
                        summary.map(|s| (s, queue))
                    } else {
                        None
                    }
                };

                // Deliver summary outside the write lock to avoid blocking other operations
                if let Some((summary, queue_handle)) = transition {
                    info!(message = %summary, "Delivering post-meeting summary via TTS");
                    if let Some(queue) = queue_handle {
                        let mode =
                            crate::claude_utils::notification_mode::get_notification_mode();
                        let speak_req = SpeakRequest {
                            message: summary,
                            voice: None,
                            priority: None,
                            project: None,
                            mode: None,
                            notification_type: Some("meeting_summary".to_string()),
                            message_type: MessageType::Brief,
                            channels: None,
                        };
                        queue.try_send(PlaybackMessage {
                            request: speak_req,
                            mode,
                            queued_at: Instant::now(),
                        });
                    } else {
                        warn!("No playback queue available for post-meeting summary");
                    }
                }
            }
        });

        // Build the axum router for this receiver.
        let app = build_receiver_router(Arc::clone(&self.state));

        // Spawn axum HTTP server.
        let mut axum_handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("axum receiver server error: {}", e);
            }
        });

        let mut buffer_flush_interval = tokio::time::interval(Duration::from_millis(500));
        let mut message_prune_interval = tokio::time::interval(Duration::from_secs(
            super::state::MESSAGE_PRUNE_INTERVAL_SECS,
        ));

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("TTS Receiver shutting down");
                    break;
                }

                _ = buffer_flush_interval.tick() => {
                    let state = Arc::clone(&self.state);
                    tokio::spawn(async move {
                        Self::flush_ready_buffers(state).await;
                    });
                }

                _ = message_prune_interval.tick() => {
                    let store = {
                        let state_guard = self.state.read().await;
                        Arc::clone(&state_guard.message_store)
                    };
                    Self::prune_message_store(&store);
                }

                result = &mut axum_handle => {
                    match result {
                        Ok(()) => warn!("axum server task exited unexpectedly"),
                        Err(e) => warn!("axum server task panicked: {}", e),
                    }
                    break;
                }
            }
        }

        meeting_poll_handle.abort();
        info!("Flushing remaining buffers before shutdown");
        Self::flush_ready_buffers(Arc::clone(&self.state)).await;

        {
            let mut state = self.state.write().await;
            state.playback_queue = None;
        }
        info!("Playback queue handle dropped, waiting for consumer drain");

        match tokio::time::timeout(Duration::from_secs(10), queue_join).await {
            Ok(Ok(())) => info!("Playback queue drained successfully"),
            Ok(Err(e)) => warn!("Playback queue task panicked: {}", e),
            Err(_) => warn!("Playback queue drain timed out after 10s"),
        }

        {
            let mut state = self.state.write().await;
            state.running = false;
        }

        Ok(())
    }

    async fn health_check(&self) -> bool {
        let state = self.state.read().await;
        state.running
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
