//! HTTP routing and request parsing.
//!
//! Contains handle_request, handle_connection, parse_request, format_response.

use super::{
    BannerDelivery, BufferEntry, PlaybackMessage, QueuedNotification,
    WatchTokenStore,
};
use crate::config::NotificationsConfig;
use crate::services::receiver::service::{
    Channel, ErrorResponse, HealthResponse, LastNotificationInfo, MessageType,
    NotificationRecord, PlayRequest, ReceiverService, RegisterWatchRequest, RegisterWatchResponse,
    SpeakRequest, SuccessResponse, VERSION,
};
use crate::services::receiver::service::NOTIFICATION_HISTORY_CAPACITY;
use crate::services::receiver::state::ReceiverState;
use chrono::Utc;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

impl ReceiverService {
    /// Handle incoming HTTP request
    pub(crate) async fn handle_request(
        method: &str,
        path: &str,
        body: &[u8],
        state: Arc<RwLock<ReceiverState>>,
    ) -> (u16, String, Vec<u8>) {
        match (method, path) {
            ("GET", "/health") => {
                let state = state.read().await;
                let uptime_seconds = state
                    .started_at
                    .map(|start| (Utc::now() - start).num_seconds().max(0) as u64)
                    .unwrap_or(0);

                let audio = Self::probe_audio_health().await;

                let response = HealthResponse {
                    status: "healthy".to_string(),
                    uptime_seconds,
                    port: state.port,
                    buffers: state.buffer_count,
                    version: VERSION.to_string(),
                    audio: Some(audio),
                };
                let body = serde_json::to_vec(&response).unwrap_or_default();
                (200, "application/json".to_string(), body)
            }

            ("GET", "/status/notifications") => {
                let state_guard = state.read().await;
                let uptime_seconds = state_guard
                    .started_at
                    .map(|start| (Utc::now() - start).num_seconds().max(0) as u64)
                    .unwrap_or(0);

                let socket_path = std::env::var("NEXUS_SOCKET")
                    .unwrap_or_else(|_| "/tmp/nexus-agent.sock".to_string());
                let socket_exists = std::path::Path::new(&socket_path).exists();

                let is_macos = std::env::consts::OS == "macos";
                let tts_available = true;
                let apns_available = true;
                let banner_available = is_macos;

                let last_notification = state_guard.last_notification.as_ref().map(|ln| {
                    serde_json::json!({
                        "timestamp": ln.timestamp.to_rfc3339(),
                        "message_type": ln.message_type,
                        "channels_used": ln.channels_used,
                    })
                });

                let pending_buffers = state_guard.buffer_count;

                drop(state_guard);
                let dedup_cache_size = {
                    let mut state_guard = state.write().await;
                    state_guard.deduplicator.cache_size()
                };

                let response = serde_json::json!({
                    "socket": {
                        "active": socket_exists,
                        "path": socket_path,
                    },
                    "channels": {
                        "tts": { "available": tts_available },
                        "apns": { "available": apns_available },
                        "banner": {
                            "available": banner_available,
                            "reason": if !banner_available { Some("not macOS") } else { None::<&str> },
                        },
                    },
                    "last_notification": last_notification,
                    "queue": { "pending_buffers": pending_buffers },
                    "dedup_cache_size": dedup_cache_size,
                    "uptime_seconds": uptime_seconds,
                });

                let body = serde_json::to_vec(&response).unwrap_or_default();
                (200, "application/json".to_string(), body)
            }

            ("POST", "/speak") => match serde_json::from_slice::<SpeakRequest>(body) {
                Ok(req) => {
                    let notification_type = req
                        .notification_type
                        .as_deref()
                        .unwrap_or("background_tasks");

                    info!(
                        "Received speak request [type={}, message_type={:?}]: {:?}",
                        notification_type, req.message_type, req.message
                    );

                    let _message_id = if req.message_type == MessageType::Extended {
                        let store = {
                            let state_guard = state.read().await;
                            Arc::clone(&state_guard.message_store)
                        };
                        let id = Self::store_message(
                            &store,
                            &req.message,
                            req.message_type,
                            req.project.as_deref(),
                        );
                        info!("Extended message stored with id={}", id);
                        Some(id)
                    } else {
                        None
                    };

                    {
                        let record = NotificationRecord {
                            message: req.message.clone(),
                            project: req.project.clone(),
                            timestamp: Utc::now(),
                            notification_type: req.notification_type.clone(),
                        };
                        let history = {
                            let state_guard = state.read().await;
                            Arc::clone(&state_guard.notification_history)
                        };
                        let mut buf = history.lock().unwrap();
                        if buf.len() >= NOTIFICATION_HISTORY_CAPACITY {
                            buf.pop_front();
                        }
                        buf.push_back(record);
                    }

                    if Self::should_block_message(&req.message) {
                        info!("Blocking ambiguous message: {:?}", req.message);
                        let response = SuccessResponse {
                            success: true,
                            message: Some("Blocked (ambiguous message)".to_string()),
                            played: None,
                            provider: None,
                            mode_resolved: None,
                            mode_source: None,
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        return (200, "application/json".to_string(), body);
                    }

                    let (effective_mode, mode_source) = {
                        use crate::claude_utils::notification_mode::NotificationMode;

                        let (base_mode, base_source) = match req
                            .mode
                            .as_deref()
                            .and_then(|m| m.parse::<NotificationMode>().ok())
                        {
                            Some(m) => (m, "request".to_string()),
                            None => {
                                let server_mode =
                                    crate::claude_utils::notification_mode::get_notification_mode();
                                if server_mode != NotificationMode::Full {
                                    (server_mode, "server_state".to_string())
                                } else {
                                    (NotificationMode::Full, "default".to_string())
                                }
                            }
                        };

                        let config =
                            crate::claude_utils::notification_config::load_notification_config();
                        match crate::claude_utils::notification_config::get_type_mode(
                            &config,
                            notification_type,
                        ) {
                            Some(type_mode) if type_mode.is_stricter_than(&base_mode) => {
                                (type_mode, "per_type".to_string())
                            }
                            _ => (base_mode, base_source),
                        }
                    };

                    let requested_channels = req
                        .channels
                        .clone()
                        .unwrap_or_else(|| Channel::defaults_for(req.message_type));

                    let available_channels = Channel::filter_available(&requested_channels);

                    info!(
                        "Channel routing: requested={:?}, available={:?}",
                        requested_channels
                            .iter()
                            .map(|c| c.to_string())
                            .collect::<Vec<_>>(),
                        available_channels
                            .iter()
                            .map(|c| c.to_string())
                            .collect::<Vec<_>>(),
                    );

                    let active_channels = {
                        let mut channels = available_channels.clone();

                        if effective_mode
                            == crate::claude_utils::notification_mode::NotificationMode::Silent
                        {
                            channels.retain(|ch| *ch != Channel::Tts);
                            if channels.is_empty() {
                                info!(
                                    "Silent mode [type={}]: all channels suppressed for: {:?}",
                                    notification_type, req.message
                                );
                                let response = SuccessResponse {
                                    success: true,
                                    message: Some("Skipped (silent mode)".to_string()),
                                    played: Some(false),
                                    provider: None,
                                    mode_resolved: Some(effective_mode.to_string()),
                                    mode_source: Some(mode_source.clone()),
                                };
                                let body = serde_json::to_vec(&response).unwrap_or_default();
                                return (200, "application/json".to_string(), body);
                            }
                        }

                        {
                            let notification_config =
                                crate::claude_utils::notification_config::load_notification_config(
                                );
                            if let Some(suppression) = notification_config.suppression {
                                let mut state_guard = state.write().await;
                                if let Some(reason) = state_guard
                                    .suppression_checker
                                    .should_suppress(
                                        suppression.video_call_detection,
                                        suppression.dnd_detection,
                                    )
                                    .await
                                {
                                    info!(
                                        "Focus mode active ({}): suppressing tts+banner, allowing apns for: {:?}",
                                        reason, req.message
                                    );
                                    channels.retain(|ch| *ch == Channel::Apns);
                                    if channels.is_empty() {
                                        info!(
                                            "Notification fully suppressed: {} for: {:?}",
                                            reason, req.message
                                        );
                                        let response = SuccessResponse {
                                            success: true,
                                            message: Some(format!("Suppressed ({})", reason)),
                                            played: Some(false),
                                            provider: None,
                                            mode_resolved: Some(effective_mode.to_string()),
                                            mode_source: Some(mode_source.clone()),
                                        };
                                        let body =
                                            serde_json::to_vec(&response).unwrap_or_default();
                                        return (200, "application/json".to_string(), body);
                                    }
                                }
                            }
                        }

                        channels
                    };

                    info!(
                        "Active channels after suppression: {:?}",
                        active_channels
                            .iter()
                            .map(|c| c.to_string())
                            .collect::<Vec<_>>(),
                    );

                    {
                        let mut state_guard = state.write().await;
                        state_guard.last_notification = Some(LastNotificationInfo {
                            timestamp: Utc::now(),
                            message_type: req.message_type,
                            channels_used: active_channels.iter().map(|c| c.to_string()).collect(),
                        });
                    }

                    if active_channels.contains(&Channel::Apns) {
                        let watch_message = req.message.clone();
                        let watch_project = req.project.clone();
                        let watch_type = notification_type.to_string();
                        let watch_mode = effective_mode;
                        let watch_message_id = _message_id.clone();
                        tokio::spawn(async move {
                            Self::deliver_to_watch(
                                &watch_message,
                                watch_project.as_deref(),
                                &watch_type,
                                watch_mode,
                                watch_message_id.as_deref(),
                            )
                            .await;
                        });
                    }

                    if active_channels.contains(&Channel::Banner) {
                        let banner_message = req.message.clone();
                        let banner_project = req.project.clone();
                        tokio::spawn(async move {
                            let title = match banner_project.as_deref() {
                                Some(p) if !p.is_empty() && p != "global" => {
                                    Some(p.to_uppercase())
                                }
                                _ => None,
                            };
                            match BannerDelivery::deliver(&banner_message, title.as_deref()).await {
                                Ok(true) => info!("Banner delivered"),
                                Ok(false) => debug!("Banner skipped (not macOS)"),
                                Err(e) => warn!("Banner delivery failed: {}", e),
                            }
                        });
                    }

                    if !active_channels.contains(&Channel::Tts) {
                        info!("TTS not in active channels, returning after non-TTS dispatch");
                        let response = SuccessResponse {
                            success: true,
                            message: Some("Delivered to non-TTS channels".to_string()),
                            played: Some(false),
                            provider: None,
                            mode_resolved: Some(effective_mode.to_string()),
                            mode_source: Some(mode_source.clone()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        return (200, "application/json".to_string(), body);
                    }

                    let (force_flush_result, config, _batching_enabled) = {
                        let mut state_guard = state.write().await;
                        let is_extended = req.message_type == MessageType::Extended;
                        if state_guard
                            .deduplicator
                            .is_duplicate_ext(&req.message, is_extended)
                        {
                            info!("Skipping duplicate message: {:?}", req.message);
                            let response = SuccessResponse {
                                success: true,
                                message: Some(
                                    "Skipped (duplicate within dedup window)".to_string(),
                                ),
                                played: None,
                                provider: None,
                                mode_resolved: None,
                                mode_source: None,
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            return (200, "application/json".to_string(), body);
                        }

                        {
                            let key = req.project.as_deref().unwrap_or("global").to_string();
                            state_guard
                                .operation_start_times
                                .entry(key)
                                .or_insert_with(Instant::now);
                        }

                        let batching_enabled = state_guard.config.batching.enabled;

                        if batching_enabled {
                            let notification = QueuedNotification {
                                message: req.message.clone(),
                                notification_type: notification_type.to_string(),
                                project: req.project.clone(),
                                received_at: Instant::now(),
                            };

                            if let Some(_immediate_message) =
                                state_guard.notification_batch.add(notification)
                            {
                                debug!(
                                    "Notification not batched, proceeding with immediate delivery"
                                );
                            } else {
                                info!(
                                    "Notification batched [type={}]: {:?}",
                                    notification_type, req.message
                                );
                                let response = SuccessResponse {
                                    success: true,
                                    message: Some(
                                        "Batched (waiting for coalesce window)".to_string(),
                                    ),
                                    played: None,
                                    provider: None,
                                    mode_resolved: None,
                                    mode_source: None,
                                };
                                let body = serde_json::to_vec(&response).unwrap_or_default();
                                return (200, "application/json".to_string(), body);
                            }
                        }

                        let entry = BufferEntry {
                            message: req.message.clone(),
                            project: req.project.clone(),
                            voice: req.voice.clone(),
                            received_at: Instant::now(),
                        };

                        let flush_result = state_guard.message_buffer.add_message(entry);
                        state_guard.buffer_count = state_guard.message_buffer.total_count();

                        (flush_result, state_guard.config.clone(), batching_enabled)
                    };

                    if let Some((combined_message, project, voice)) = force_flush_result {
                        info!("Force flushing buffer, queuing: {:?}", combined_message);
                        let speak_req = SpeakRequest {
                            message: combined_message,
                            voice,
                            priority: req.priority,
                            project,
                            mode: req.mode.clone(),
                            notification_type: req.notification_type.clone(),
                            message_type: req.message_type,
                            channels: req.channels.clone(),
                        };

                        let queue_handle = {
                            let state_guard = state.read().await;
                            state_guard.playback_queue.clone()
                        };
                        if let Some(queue) = queue_handle {
                            queue.try_send(PlaybackMessage {
                                request: speak_req,
                                mode: effective_mode,
                                queued_at: Instant::now(),
                            });
                        }

                        {
                            let mut state_guard = state.write().await;
                            state_guard.buffer_count = state_guard.message_buffer.total_count();
                        }

                        let response = SuccessResponse {
                            success: true,
                            message: Some("Queued for playback".to_string()),
                            played: None,
                            provider: None,
                            mode_resolved: Some(effective_mode.to_string()),
                            mode_source: Some(mode_source.clone()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (200, "application/json".to_string(), body)
                    } else {
                        info!("Message buffered, waiting for debounce window");
                        let debounce_ms = config.debounce.window_ms;
                        let response = SuccessResponse {
                            success: true,
                            message: Some(format!(
                                "Buffered (waiting for {}ms debounce window)",
                                debounce_ms
                            )),
                            played: None,
                            provider: None,
                            mode_resolved: Some(effective_mode.to_string()),
                            mode_source: Some(mode_source.clone()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (200, "application/json".to_string(), body)
                    }
                }
                Err(e) => {
                    let response = ErrorResponse {
                        error: "Invalid request body".to_string(),
                        details: Some(e.to_string()),
                    };
                    let body = serde_json::to_vec(&response).unwrap_or_default();
                    (400, "application/json".to_string(), body)
                }
            },

            ("POST", "/play") => match serde_json::from_slice::<PlayRequest>(body) {
                Ok(req) => {
                    info!("Received play request: {:?}", req.path);
                    let path = PathBuf::from(&req.path);
                    if !path.exists() {
                        let response = ErrorResponse {
                            error: "File not found".to_string(),
                            details: Some(req.path.clone()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        return (404, "application/json".to_string(), body);
                    }

                    match Self::play_audio_file(&req.path).await {
                        Ok(()) => {
                            let response = SuccessResponse {
                                success: true,
                                message: Some(format!("Played: {}", req.path)),
                                played: None,
                                provider: None,
                                mode_resolved: None,
                                mode_source: None,
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (200, "application/json".to_string(), body)
                        }
                        Err(e) => {
                            let response = ErrorResponse {
                                error: "Playback failed".to_string(),
                                details: Some(e),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (500, "application/json".to_string(), body)
                        }
                    }
                }
                Err(e) => {
                    let response = ErrorResponse {
                        error: "Invalid request body".to_string(),
                        details: Some(e.to_string()),
                    };
                    let body = serde_json::to_vec(&response).unwrap_or_default();
                    (400, "application/json".to_string(), body)
                }
            },

            ("POST", "/imessage") => {
                #[derive(Deserialize)]
                struct IMessageRequest {
                    recipient: String,
                    message: String,
                }

                match serde_json::from_slice::<IMessageRequest>(body) {
                    Ok(req) => {
                        info!("Received iMessage request to {}", req.recipient);
                        let success = Self::send_imessage(&req.recipient, &req.message).await;
                        if success {
                            let response = SuccessResponse {
                                success: true,
                                message: Some(format!("iMessage sent to {}", req.recipient)),
                                played: None,
                                provider: Some("Messages.app".to_string()),
                                mode_resolved: None,
                                mode_source: None,
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (200, "application/json".to_string(), body)
                        } else {
                            let response = ErrorResponse {
                                error: "iMessage failed".to_string(),
                                details: Some("Check Messages.app permissions".to_string()),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (500, "application/json".to_string(), body)
                        }
                    }
                    Err(e) => {
                        let response = ErrorResponse {
                            error: "Invalid request body".to_string(),
                            details: Some(e.to_string()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (400, "application/json".to_string(), body)
                    }
                }
            }

            ("POST", "/watch/register") => {
                match serde_json::from_slice::<RegisterWatchRequest>(body) {
                    Ok(req) => {
                        info!(
                            "Received watch registration: device_token={}, platform={}",
                            req.device_token, req.platform
                        );
                        if req.device_token.trim().is_empty() {
                            let response = ErrorResponse {
                                error: "Invalid device_token".to_string(),
                                details: Some("device_token cannot be empty".to_string()),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            return (400, "application/json".to_string(), body);
                        }

                        match WatchTokenStore::open() {
                            Ok(store) => {
                                match store.register_token(&req.device_token, &req.platform) {
                                    Ok(()) => {
                                        info!(
                                            "Successfully registered watch device: {}",
                                            req.device_token
                                        );
                                        let response = RegisterWatchResponse {
                                            status: "registered".to_string(),
                                        };
                                        let body =
                                            serde_json::to_vec(&response).unwrap_or_default();
                                        (200, "application/json".to_string(), body)
                                    }
                                    Err(e) => {
                                        error!("Failed to register watch token: {}", e);
                                        let response = ErrorResponse {
                                            error: "Registration failed".to_string(),
                                            details: Some(e.to_string()),
                                        };
                                        let body =
                                            serde_json::to_vec(&response).unwrap_or_default();
                                        (500, "application/json".to_string(), body)
                                    }
                                }
                            }
                            Err(e) => {
                                error!("Failed to open watch token store: {}", e);
                                let response = ErrorResponse {
                                    error: "Store initialization failed".to_string(),
                                    details: Some(e.to_string()),
                                };
                                let body = serde_json::to_vec(&response).unwrap_or_default();
                                (500, "application/json".to_string(), body)
                            }
                        }
                    }
                    Err(e) => {
                        let response = ErrorResponse {
                            error: "Invalid request body".to_string(),
                            details: Some(e.to_string()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (400, "application/json".to_string(), body)
                    }
                }
            }

            ("GET", "/mode") => {
                let state = crate::claude_utils::notification_mode::get_notification_mode();
                let state_path =
                    crate::claude_utils::notification_mode::notification_mode_state_path();

                let (updated_at, updated_by) = match std::fs::read_to_string(&state_path) {
                    Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
                        Ok(v) => (
                            v.get("updated_at")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string(),
                            v.get("updated_by")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string(),
                        ),
                        Err(_) => ("unknown".to_string(), "unknown".to_string()),
                    },
                    Err(_) => ("unknown".to_string(), "unknown".to_string()),
                };

                let response = serde_json::json!({
                    "mode": state.to_string(),
                    "updated_at": updated_at,
                    "updated_by": updated_by,
                });
                let body = serde_json::to_vec(&response).unwrap_or_default();
                (200, "application/json".to_string(), body)
            }

            ("POST", "/mode") => {
                #[derive(Deserialize)]
                struct SetModeRequest {
                    mode: String,
                }

                match serde_json::from_slice::<SetModeRequest>(body) {
                    Ok(req) => {
                        match req
                            .mode
                            .parse::<crate::claude_utils::notification_mode::NotificationMode>()
                        {
                            Ok(new_mode) => {
                                let previous =
                                    crate::claude_utils::notification_mode::get_notification_mode();
                                match crate::claude_utils::notification_mode::set_notification_mode(
                                    new_mode,
                                    "remote_api",
                                ) {
                                    Ok(()) => {
                                        info!("Mode changed via API: {} -> {}", previous, new_mode);
                                        let response = serde_json::json!({
                                            "mode": new_mode.to_string(),
                                            "previous": previous.to_string(),
                                        });
                                        let body =
                                            serde_json::to_vec(&response).unwrap_or_default();
                                        (200, "application/json".to_string(), body)
                                    }
                                    Err(e) => {
                                        let response = ErrorResponse {
                                            error: "Failed to set mode".to_string(),
                                            details: Some(e.to_string()),
                                        };
                                        let body =
                                            serde_json::to_vec(&response).unwrap_or_default();
                                        (500, "application/json".to_string(), body)
                                    }
                                }
                            }
                            Err(e) => {
                                let response = ErrorResponse {
                                    error: "Invalid mode".to_string(),
                                    details: Some(e.to_string()),
                                };
                                let body = serde_json::to_vec(&response).unwrap_or_default();
                                (400, "application/json".to_string(), body)
                            }
                        }
                    }
                    Err(e) => {
                        let response = ErrorResponse {
                            error: "Invalid request body".to_string(),
                            details: Some(e.to_string()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (400, "application/json".to_string(), body)
                    }
                }
            }

            ("POST", "/mode/cycle") => {
                let previous = crate::claude_utils::notification_mode::get_notification_mode();
                match crate::claude_utils::notification_mode::cycle_notification_mode() {
                    Ok(new_mode) => {
                        info!("Mode cycled via API: {} -> {}", previous, new_mode);
                        let response = serde_json::json!({
                            "mode": new_mode.to_string(),
                            "previous": previous.to_string(),
                        });
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (200, "application/json".to_string(), body)
                    }
                    Err(e) => {
                        let response = ErrorResponse {
                            error: "Failed to cycle mode".to_string(),
                            details: Some(e.to_string()),
                        };
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        (500, "application/json".to_string(), body)
                    }
                }
            }

            ("POST", "/reload") => {
                let state_guard = state.read().await;
                if let Some(ref shared_config) = state_guard.shared_config {
                    let shared_config = Arc::clone(shared_config);
                    drop(state_guard);
                    match NotificationsConfig::load() {
                        Ok(new_config) => {
                            {
                                let mut config_guard = shared_config.write().await;
                                *config_guard = new_config.clone();
                            }
                            {
                                let mut state_guard = state.write().await;
                                state_guard.config = new_config;
                            }
                            let response = serde_json::json!({
                                "status": "ok",
                                "reloaded_at": Utc::now().to_rfc3339(),
                            });
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (200, "application/json".to_string(), body)
                        }
                        Err(e) => {
                            let response = serde_json::json!({
                                "status": "error",
                                "message": e.to_string(),
                            });
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (500, "application/json".to_string(), body)
                        }
                    }
                } else {
                    let response = serde_json::json!({
                        "status": "error",
                        "message": "Hot reload not available (daemon started without shared config)",
                    });
                    let body = serde_json::to_vec(&response).unwrap_or_default();
                    (501, "application/json".to_string(), body)
                }
            }

            ("GET", "/history") => {
                let state_guard = state.read().await;
                let history_guard = state_guard.notification_history.lock().unwrap();
                let records: Vec<_> = history_guard.iter().rev().collect();
                let body = serde_json::to_vec(&records).unwrap_or_else(|_| b"[]".to_vec());
                (200, "application/json".to_string(), body)
            }

            ("GET", "/sessions") => (200, "application/json".to_string(), b"[]".to_vec()),

            ("GET", "/messages") => {
                let home = std::env::var("HOME").unwrap_or_default();
                let messages_path = format!("{}/.claude/state/imessages.json", home);
                match std::fs::read_to_string(&messages_path) {
                    Ok(json) => (200, "application/json".to_string(), json.into_bytes()),
                    Err(_) => (200, "application/json".to_string(), b"[]".to_vec()),
                }
            }

            ("GET", p) if p.starts_with("/messages/") => {
                let id = &p["/messages/".len()..];
                if id.is_empty() {
                    let response = ErrorResponse {
                        error: "Missing message ID".to_string(),
                        details: None,
                    };
                    let body = serde_json::to_vec(&response).unwrap_or_default();
                    (400, "application/json".to_string(), body)
                } else {
                    let store = {
                        let state_guard = state.read().await;
                        Arc::clone(&state_guard.message_store)
                    };
                    let guard = store.lock().unwrap();
                    match guard.get(id) {
                        Some(msg) if msg.expires_at > Utc::now() => {
                            let body = serde_json::to_vec(msg).unwrap_or_default();
                            (200, "application/json".to_string(), body)
                        }
                        _ => {
                            let response = ErrorResponse {
                                error: "Message not found".to_string(),
                                details: Some(format!("No message with id '{}'", id)),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            (404, "application/json".to_string(), body)
                        }
                    }
                }
            }

            _ => {
                let response = ErrorResponse {
                    error: "Not found".to_string(),
                    details: Some(format!("{} {}", method, path)),
                };
                let body = serde_json::to_vec(&response).unwrap_or_default();
                (404, "application/json".to_string(), body)
            }
        }
    }

    /// Parse HTTP request from raw bytes
    pub(crate) fn parse_request(data: &[u8]) -> Option<(String, String, Vec<u8>)> {
        let request_str = String::from_utf8_lossy(data);
        let lines: Vec<&str> = request_str.lines().collect();

        if lines.is_empty() {
            return None;
        }

        let parts: Vec<&str> = lines[0].split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }

        let method = parts[0].to_string();
        let path = parts[1].to_string();

        let mut body_start = 0;
        let mut content_length: usize = 0;

        for (i, line) in lines.iter().enumerate() {
            if line.to_lowercase().starts_with("content-length:") {
                if let Some(len_str) = line.split(':').nth(1) {
                    content_length = len_str.trim().parse().unwrap_or(0);
                }
            }
            if line.is_empty() {
                body_start = i + 1;
                break;
            }
        }

        let body = if body_start > 0 && content_length > 0 {
            let header_end = request_str
                .find("\r\n\r\n")
                .map(|p| p + 4)
                .or_else(|| request_str.find("\n\n").map(|p| p + 2))
                .unwrap_or(data.len());

            if header_end < data.len() {
                data[header_end..].to_vec()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        Some((method, path, body))
    }

    /// Format HTTP response
    pub(crate) fn format_response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
        let status_text = match status {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            500 => "Internal Server Error",
            _ => "Unknown",
        };

        let headers = format!(
            "HTTP/1.1 {} {}\r\n\
             Content-Type: {}\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\
             \r\n",
            status,
            status_text,
            content_type,
            body.len()
        );

        let mut response = headers.into_bytes();
        response.extend_from_slice(body);
        response
    }

    /// Handle a single TCP connection
    pub(crate) async fn handle_connection(
        mut stream: TcpStream,
        state: Arc<RwLock<ReceiverState>>,
    ) {
        let mut buffer = vec![0u8; 8192];

        match stream.read(&mut buffer).await {
            Ok(n) if n > 0 => {
                if let Some((method, path, body)) = Self::parse_request(&buffer[..n]) {
                    debug!("Request: {} {}", method, path);

                    let (status, content_type, response_body) =
                        Self::handle_request(&method, &path, &body, state).await;

                    let response = Self::format_response(status, &content_type, &response_body);

                    if let Err(e) = stream.write_all(&response).await {
                        error!("Failed to write response: {}", e);
                    }
                } else {
                    warn!("Failed to parse HTTP request");
                    let response = Self::format_response(400, "text/plain", b"Bad Request");
                    let _ = stream.write_all(&response).await;
                }
            }
            Ok(_) => {
                debug!("Empty request received");
            }
            Err(e) => {
                error!("Failed to read from connection: {}", e);
            }
        }
    }
}
