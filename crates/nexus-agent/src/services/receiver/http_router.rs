//! HTTP routing via axum.
//!
//! Contains the axum Router builder and the internal `handle_request` dispatch
//! (used by both axum handlers and the `speak_from_socket` internal caller).

use super::{BannerDelivery, BufferEntry, PlaybackMessage, QueuedNotification, WatchTokenStore};
use crate::config::NotificationsConfig;
use crate::services::receiver::service::NOTIFICATION_HISTORY_CAPACITY;
use crate::services::receiver::service::{
    Channel, ErrorResponse, HealthResponse, LastNotificationInfo, MessageType, NotificationRecord,
    PlayRequest, ReceiverService, RegisterWatchRequest, RegisterWatchResponse, SpeakRequest,
    SuccessResponse, VERSION,
};
use crate::services::receiver::state::ReceiverState;
use axum::body::Bytes;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use chrono::Utc;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

/// Shared state for axum receiver handlers.
pub(crate) type ReceiverRouter = axum::Router;

/// Build the axum Router for the ReceiverService.
///
/// All routes delegate to `ReceiverService::handle_request` so the handler
/// logic stays in one place while axum handles HTTP parsing, connection
/// management, and response formatting.
pub(crate) fn build_receiver_router(state: Arc<RwLock<ReceiverState>>) -> ReceiverRouter {
    use axum::routing::{get, post};

    axum::Router::new()
        .route("/health", get(axum_get_handler))
        .route("/status/notifications", get(axum_get_handler))
        .route("/mode", get(axum_get_handler).post(axum_post_handler))
        .route("/mode/cycle", post(axum_post_handler))
        .route("/reload", post(axum_post_handler))
        .route("/history", get(axum_get_handler))
        .route("/sessions", get(axum_get_handler))
        .route("/messages", get(axum_get_handler))
        .route("/messages/{id}", get(axum_get_with_path_handler))
        .route("/speak", post(axum_post_handler))
        .route("/play", post(axum_post_handler))
        .route("/imessage", post(axum_post_handler))
        .route("/watch/register", post(axum_post_handler))
        .fallback(axum_fallback_handler)
        .with_state(state)
}

/// Axum handler for GET routes — extracts path and delegates to handle_request.
async fn axum_get_handler(
    AxumState(state): AxumState<Arc<RwLock<ReceiverState>>>,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    let path = uri.path();
    let (status, content_type, body) =
        ReceiverService::handle_request("GET", path, &[], state).await;
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(axum::http::header::CONTENT_TYPE, content_type)],
        body,
    )
}

/// Axum handler for GET routes with path parameters (e.g. /messages/{id}).
async fn axum_get_with_path_handler(
    AxumState(state): AxumState<Arc<RwLock<ReceiverState>>>,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    let path = uri.path();
    let (status, content_type, body) =
        ReceiverService::handle_request("GET", path, &[], state).await;
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(axum::http::header::CONTENT_TYPE, content_type)],
        body,
    )
}

/// Axum handler for POST routes — extracts path + body and delegates.
async fn axum_post_handler(
    AxumState(state): AxumState<Arc<RwLock<ReceiverState>>>,
    uri: axum::http::Uri,
    body: Bytes,
) -> impl IntoResponse {
    let path = uri.path();
    let (status, content_type, resp_body) =
        ReceiverService::handle_request("POST", path, &body, state).await;
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(axum::http::header::CONTENT_TYPE, content_type)],
        resp_body,
    )
}

/// Fallback for unmatched routes.
async fn axum_fallback_handler(
    method: axum::http::Method,
    uri: axum::http::Uri,
) -> impl IntoResponse {
    let response = ErrorResponse {
        error: "Not found".to_string(),
        details: Some(format!("{} {}", method, uri.path())),
    };
    let body = serde_json::to_vec(&response).unwrap_or_default();
    (
        StatusCode::NOT_FOUND,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json".to_string(),
        )],
        body,
    )
}

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

                let audio = super::audio::probe_audio_health().await;

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
                let meeting_active = state_guard.is_meeting_active();

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
                    "meeting_active": meeting_active,
                });

                let body = serde_json::to_vec(&response).unwrap_or_default();
                (200, "application/json".to_string(), body)
            }

            ("POST", "/speak") => match serde_json::from_slice::<SpeakRequest>(body) {
                Ok(req) => {
                    // Input validation (D8): reject empty or oversized messages.
                    if req.message.is_empty() {
                        let response = serde_json::json!({
                            "error": "validation",
                            "detail": "message is empty"
                        });
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        return (400, "application/json".to_string(), body);
                    }
                    if req.message.len() > 500 {
                        let response = serde_json::json!({
                            "error": "validation",
                            "detail": "message exceeds 500 characters"
                        });
                        let body = serde_json::to_vec(&response).unwrap_or_default();
                        return (400, "application/json".to_string(), body);
                    }

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

                    // Skip suppression when meeting mode is active — messages will be
                    // queued by the batch buffer (focus_session_active) instead of dropped.
                    let meeting_active = {
                        let state_guard = state.read().await;
                        state_guard.is_meeting_active()
                    };

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

                        if !meeting_active {
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
                                    // Meeting/DND active: queue notification for post-meeting summary
                                    if reason == "meeting_active" {
                                        use super::meeting_queue::HeldNotification;

                                        // Update meeting state (may trigger Started transition)
                                        state_guard.meeting_queue.set_meeting_active(true);

                                        state_guard.meeting_queue.enqueue(HeldNotification {
                                            message: req.message.clone(),
                                            project: req.project.clone(),
                                            notification_type: notification_type.to_string(),
                                            received_at: Utc::now(),
                                        });

                                        let queued_count = state_guard.meeting_queue.total_count();
                                        let project_count = state_guard.meeting_queue.project_count();

                                        info!(
                                            "Meeting active: queued notification ({} total, {} projects) for: {:?}",
                                            queued_count, project_count, req.message
                                        );

                                        // Still allow APNs through during meeting
                                        channels.retain(|ch| *ch == Channel::Apns);
                                        if channels.is_empty() {
                                            let response = SuccessResponse {
                                                success: true,
                                                message: Some(format!(
                                                    "Queued for post-meeting summary ({} held)",
                                                    queued_count
                                                )),
                                                played: Some(false),
                                                provider: None,
                                                mode_resolved: Some(effective_mode.to_string()),
                                                mode_source: Some(mode_source.clone()),
                                            };
                                            let body =
                                                serde_json::to_vec(&response).unwrap_or_default();
                                            return (200, "application/json".to_string(), body);
                                        }
                                    } else {
                                        // DND: suppress as before
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
                            super::watch::deliver_to_watch(
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
                                Some(p) if !p.is_empty() && p != "global" => Some(p.to_uppercase()),
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

                        if batching_enabled || meeting_active {
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

                    match super::audio::play_audio_file(&req.path).await {
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
                        let success = super::imessage::send_imessage(&req.recipient, &req.message).await;
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

                let (updated_at, updated_by) = match tokio::fs::read_to_string(&state_path).await {
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

            ("POST", "/reload") => match NotificationsConfig::load().await {
                Ok(new_config) => {
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
            },

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
                match tokio::fs::read_to_string(&messages_path).await {
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
}
