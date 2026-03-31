//! TTS Receiver HTTP service — thin orchestrator
//!
//! Provides the ReceiverService struct, constructors, and Service trait impls.
//! Handler logic lives in sub-modules:
//! - `types` — Public request/response types, constants
//! - `state` — ReceiverState, mode/type management, message store, buffer flush
//! - `http_router` — HTTP request routing, parsing, formatting
//! - `socket` — Unix socket listener
//! - `delivery` — TTS, APNs, banner, iMessage delivery

use super::PlaybackQueue;
use crate::config::NotificationsConfig;
use crate::services::receiver::state::ReceiverState;
use crate::services::Service;
use anyhow::Result;
use chrono::Utc;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{RwLock, mpsc, watch};
use tracing::{debug, error, info, warn};

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
    shared_config: Option<Arc<tokio::sync::RwLock<NotificationsConfig>>>,
    reload_rx: Option<watch::Receiver<()>>,
}

impl ReceiverService {
    pub fn new() -> Self {
        let config = NotificationsConfig::load().unwrap_or_default();
        Self::with_config(config)
    }

    pub fn with_config(config: NotificationsConfig) -> Self {
        let port = config.server.port;
        Self {
            port,
            bind_address: "127.0.0.1".to_string(),
            state: Arc::new(RwLock::new(ReceiverState::new(config.clone()))),
            config,
            shared_config: None,
            reload_rx: None,
        }
    }

    pub fn with_shared_config(
        config: NotificationsConfig,
        shared_config: Arc<tokio::sync::RwLock<NotificationsConfig>>,
        reload_rx: watch::Receiver<()>,
    ) -> Self {
        let port = config.server.port;
        let mut receiver_state = ReceiverState::new(config.clone());
        receiver_state.shared_config = Some(Arc::clone(&shared_config));
        Self {
            port,
            bind_address: "127.0.0.1".to_string(),
            state: Arc::new(RwLock::new(receiver_state)),
            config,
            shared_config: Some(shared_config),
            reload_rx: Some(reload_rx),
        }
    }

    pub fn with_port(port: u16) -> Self {
        let mut config = NotificationsConfig::load().unwrap_or_default();
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
        let addr: SocketAddr = format!("{}:{}", self.bind_address, self.port)
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid bind address '{}:{}': {}", self.bind_address, self.port, e))?;
        let listener = TcpListener::bind(addr).await?;

        info!("TTS Receiver listening on http://{}:{}", self.bind_address, self.port);

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

                result = listener.accept() => {
                    match result {
                        Ok((stream, peer_addr)) => {
                            debug!("Connection from {}", peer_addr);
                            let state = Arc::clone(&self.state);
                            tokio::spawn(async move {
                                Self::handle_connection(stream, state).await;
                            });
                        }
                        Err(e) => {
                            error!("Failed to accept connection: {}", e);
                        }
                    }
                }
            }
        }

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
