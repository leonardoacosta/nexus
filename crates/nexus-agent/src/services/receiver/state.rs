//! Receiver state management
//!
//! Contains `ReceiverState`, mode/type management, and message store functions.

use super::{
    Deduplicator, MeetingQueue, MessageBuffer, NotificationBatchBuffer, PlaybackMessage,
    PlaybackQueueHandle, SuppressionChecker,
};
use crate::config::NotificationsConfig;
use crate::services::receiver::service::{
    LastNotificationInfo, MessageType, NOTIFICATION_HISTORY_CAPACITY, NotificationRecord,
    SpeakRequest, StoredMessage,
};
use chrono::{DateTime, Utc};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, info};
use uuid::Uuid;

/// TTL for stored messages (1 hour)
pub(crate) const MESSAGE_STORE_TTL_SECS: i64 = 3600;
/// Interval for pruning expired messages (5 minutes)
pub(crate) const MESSAGE_PRUNE_INTERVAL_SECS: u64 = 300;

/// TTS Receiver service state
pub struct ReceiverState {
    pub port: u16,
    pub running: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub buffer_count: usize,
    pub(crate) deduplicator: Deduplicator,
    pub(crate) message_buffer: MessageBuffer,
    pub(crate) notification_batch: NotificationBatchBuffer,
    pub(crate) config: NotificationsConfig,
    pub(crate) operation_start_times: HashMap<String, Instant>,
    pub(crate) last_imessage_times: HashMap<String, Instant>,
    pub(crate) suppression_checker: SuppressionChecker,
    pub(crate) meeting_queue: MeetingQueue,
    pub playback_queue: Option<PlaybackQueueHandle>,
    pub notification_history: Arc<Mutex<VecDeque<NotificationRecord>>>,
    pub message_store: Arc<Mutex<HashMap<String, StoredMessage>>>,
    pub last_notification: Option<LastNotificationInfo>,
    /// Whether a meeting/video call is currently detected.
    pub(crate) meeting_active: bool,
}

impl ReceiverState {
    pub(crate) fn new(config: NotificationsConfig) -> Self {
        let dedup_window = {
            let notification_config =
                crate::claude_utils::notification_config::load_notification_config();
            notification_config
                .suppression
                .map(|s| Duration::from_millis(s.dedup_window_ms))
                .unwrap_or_else(|| config.dedup_window())
        };

        Self {
            port: config.server.port,
            running: false,
            started_at: None,
            buffer_count: 0,
            deduplicator: Deduplicator::new(dedup_window),
            message_buffer: MessageBuffer::new(
                config.debounce_window(),
                config.debounce.max_buffer,
            ),
            notification_batch: NotificationBatchBuffer::new(
                config.batching.build_coalesce_window_ms,
                config.batching.reminder_coalesce,
            ),
            config,
            operation_start_times: HashMap::new(),
            last_imessage_times: HashMap::new(),
            suppression_checker: SuppressionChecker::new(),
            meeting_queue: MeetingQueue::new(),
            playback_queue: None,
            notification_history: Arc::new(Mutex::new(VecDeque::with_capacity(
                NOTIFICATION_HISTORY_CAPACITY,
            ))),
            message_store: Arc::new(Mutex::new(HashMap::new())),
            last_notification: None,
            meeting_active: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_default() -> Self {
        let config = NotificationsConfig::default();
        Self {
            port: config.server.port,
            running: false,
            started_at: None,
            buffer_count: 0,
            deduplicator: Deduplicator::new(config.dedup_window()),
            message_buffer: MessageBuffer::new(
                config.debounce_window(),
                config.debounce.max_buffer,
            ),
            notification_batch: NotificationBatchBuffer::new(
                config.batching.build_coalesce_window_ms,
                config.batching.reminder_coalesce,
            ),
            config,
            operation_start_times: HashMap::new(),
            last_imessage_times: HashMap::new(),
            suppression_checker: SuppressionChecker::new(),
            meeting_queue: MeetingQueue::new(),
            playback_queue: None,
            notification_history: Arc::new(Mutex::new(VecDeque::with_capacity(
                NOTIFICATION_HISTORY_CAPACITY,
            ))),
            message_store: Arc::new(Mutex::new(HashMap::new())),
            last_notification: None,
            meeting_active: false,
        }
    }

    /// Check if a meeting is currently detected.
    pub(crate) fn is_meeting_active(&self) -> bool {
        self.meeting_active
    }

    /// Set the meeting detection state.
    pub(crate) fn set_meeting_active(&mut self, active: bool) {
        self.meeting_active = active;
    }
}

// ---------------------------------------------------------------------------
// Mode/type management + message store + buffer flush + imessage logic
// ---------------------------------------------------------------------------

use super::ReceiverService;

impl ReceiverService {
    pub fn mode_query_json(&self) -> String {
        let mode = crate::claude_utils::notification_mode::get_notification_mode();
        serde_json::json!({ "mode": mode.to_string() }).to_string()
    }

    pub fn mode_set_json(&self, mode_str: &str) -> String {
        match mode_str.parse::<crate::claude_utils::notification_mode::NotificationMode>() {
            Ok(new_mode) => {
                let previous = crate::claude_utils::notification_mode::get_notification_mode();
                match crate::claude_utils::notification_mode::set_notification_mode(
                    new_mode,
                    "socket_command",
                ) {
                    Ok(()) => serde_json::json!({
                        "mode": new_mode.to_string(),
                        "previous": previous.to_string(),
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
                }
            }
            Err(e) => serde_json::json!({ "error": format!("invalid mode: {}", e) }).to_string(),
        }
    }

    pub fn mode_cycle_json(&self) -> String {
        let previous = crate::claude_utils::notification_mode::get_notification_mode();
        match crate::claude_utils::notification_mode::cycle_notification_mode() {
            Ok(new_mode) => serde_json::json!({
                "mode": new_mode.to_string(),
                "previous": previous.to_string(),
            })
            .to_string(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        }
    }

    pub async fn history_json(&self, limit: Option<usize>) -> String {
        let state_guard = self.state().read().await;
        let history_guard = state_guard.notification_history.lock().unwrap();
        let records: Vec<_> = history_guard
            .iter()
            .rev()
            .take(limit.unwrap_or(NOTIFICATION_HISTORY_CAPACITY))
            .collect();
        serde_json::to_string(&records).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn type_set_json(&self, type_name: &str, mode_str: &str) -> String {
        use crate::claude_utils::notification_config::{
            TypeConfig, load_notification_config, save_notification_config,
        };
        match mode_str.parse::<crate::claude_utils::notification_mode::NotificationMode>() {
            Ok(mode) => {
                let mut config = load_notification_config();
                let types = config.types.get_or_insert_with(Default::default);
                types.insert(type_name.to_string(), TypeConfig { mode: Some(mode) });
                match save_notification_config(&config) {
                    Ok(()) => serde_json::json!({
                        "type": type_name,
                        "mode": mode.to_string(),
                    })
                    .to_string(),
                    Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
                }
            }
            Err(e) => serde_json::json!({ "error": format!("invalid mode: {}", e) }).to_string(),
        }
    }

    pub fn type_clear_json(&self, type_name: &str) -> String {
        use crate::claude_utils::notification_config::{
            load_notification_config, save_notification_config,
        };
        let mut config = load_notification_config();
        if let Some(types) = config.types.as_mut() {
            types.remove(type_name);
        }
        match save_notification_config(&config) {
            Ok(()) => serde_json::json!({ "cleared": type_name }).to_string(),
            Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
        }
    }

    pub(crate) fn store_message(
        store: &Arc<Mutex<HashMap<String, StoredMessage>>>,
        message: &str,
        message_type: MessageType,
        project: Option<&str>,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let expires_at = now + chrono::Duration::seconds(MESSAGE_STORE_TTL_SECS);
        let entry = StoredMessage {
            id: id.clone(),
            message: message.to_string(),
            message_type,
            project: project.map(|s| s.to_string()),
            created_at: now,
            expires_at,
        };
        let mut guard = store.lock().unwrap();
        guard.insert(id.clone(), entry);
        id
    }

    pub(crate) fn prune_message_store(store: &Arc<Mutex<HashMap<String, StoredMessage>>>) {
        let now = Utc::now();
        let mut guard = store.lock().unwrap();
        guard.retain(|_, msg| msg.expires_at > now);
    }

    pub(crate) async fn flush_ready_buffers(state: Arc<RwLock<ReceiverState>>) {
        let (pending_keys, queue_handle): (Vec<String>, Option<PlaybackQueueHandle>) = {
            let state_guard = state.read().await;
            (
                state_guard.message_buffer.pending_project_keys(),
                state_guard.playback_queue.clone(),
            )
        };

        let queue = match queue_handle {
            Some(q) => q,
            None => {
                debug!("No playback queue available, skipping buffer flush");
                return;
            }
        };

        for key in pending_keys {
            let flush_data = {
                let mut state_guard = state.write().await;
                if state_guard.message_buffer.should_flush(&key) {
                    let (project, voice) = state_guard.message_buffer.get_buffer_info(&key);
                    state_guard
                        .message_buffer
                        .flush_buffer(&key, project, voice)
                } else {
                    None
                }
            };

            if let Some((combined_message, project, voice)) = flush_data {
                info!("Flushing buffer for {:?}: {:?}", key, combined_message);
                let mode = crate::claude_utils::notification_mode::get_notification_mode();
                let speak_req = SpeakRequest {
                    message: combined_message,
                    voice,
                    priority: None,
                    project,
                    mode: None,
                    notification_type: None,
                    message_type: MessageType::Brief,
                    channels: None,
                };
                queue.try_send(PlaybackMessage {
                    request: speak_req,
                    mode,
                    queued_at: Instant::now(),
                });
                {
                    let mut state_guard = state.write().await;
                    state_guard.buffer_count = state_guard.message_buffer.total_count();
                }
            }
        }

        let batches_to_flush = {
            let mut state_guard = state.write().await;
            state_guard.notification_batch.flush_ready()
        };

        for (notification_type, coalesced_message) in batches_to_flush {
            info!(
                "Flushing batched notifications [type={}]: {:?}",
                notification_type, coalesced_message
            );
            let mode = crate::claude_utils::notification_mode::get_notification_mode();
            let speak_req = SpeakRequest {
                message: coalesced_message,
                voice: None,
                priority: None,
                project: None,
                mode: None,
                notification_type: Some(notification_type),
                message_type: MessageType::Brief,
                channels: None,
            };
            queue.try_send(PlaybackMessage {
                request: speak_req,
                mode,
                queued_at: Instant::now(),
            });
        }
    }

    pub(crate) async fn should_send_imessage(
        state: &Arc<RwLock<ReceiverState>>,
        project: Option<&str>,
        config: &NotificationsConfig,
    ) -> bool {
        if !config.imessage.enabled || config.imessage.recipient.is_empty() {
            return false;
        }
        let key = project.unwrap_or("global").to_string();
        let state_guard = state.read().await;
        let threshold = Duration::from_secs(config.imessage.threshold_minutes * 60);
        let started = state_guard.operation_start_times.get(&key);
        let running_long_enough = started
            .map(|start| start.elapsed() >= threshold)
            .unwrap_or(false);
        if !running_long_enough {
            return false;
        }
        let throttle = Duration::from_secs(config.imessage.throttle_minutes * 60);
        let last_sent = state_guard.last_imessage_times.get(&key);
        last_sent
            .map(|last| last.elapsed() >= throttle)
            .unwrap_or(true)
    }

    #[allow(dead_code)]
    pub(crate) async fn reset_operation_tracking(
        state: &Arc<RwLock<ReceiverState>>,
        project: &str,
    ) {
        let mut state_guard = state.write().await;
        state_guard.operation_start_times.remove(project);
        state_guard.last_imessage_times.remove(project);
    }

    pub(crate) fn should_block_message(message: &str) -> bool {
        let lower = message.trim().to_lowercase();
        let blocked = [
            "claude needs assistance",
            "claude needs your attention",
            "which project",
            "needs assistance",
            "needs your attention",
        ];
        blocked.iter().any(|b| lower.contains(b))
    }

    pub(crate) fn enrich_vague_message(message: &str, project: Option<&str>) -> String {
        let trimmed = message.trim();
        let lower = trimmed.to_lowercase();
        let vague_words = [
            "done",
            "complete",
            "finished",
            "ready",
            "done.",
            "complete.",
            "finished.",
            "ready.",
        ];
        let is_vague = vague_words.iter().any(|w| lower == *w);
        if is_vague {
            let proj = project
                .map(|p| p.to_uppercase())
                .unwrap_or_else(|| "Task".to_string());
            format!("{} complete", proj)
        } else {
            trimmed.to_string()
        }
    }

    pub(crate) fn format_message_with_project(message: &str, project: Option<&str>) -> String {
        match project {
            Some(p) if !p.is_empty() && p != "global" => {
                let prefix = p.to_uppercase();
                if message.starts_with(&format!("{}:", prefix))
                    || message.starts_with(&format!("{} :", prefix))
                {
                    message.to_string()
                } else {
                    format!("{}: {}", prefix, message)
                }
            }
            _ => message.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_meeting_state_transitions() {
        let mut state = ReceiverState::new_default();

        // Initial state
        assert!(!state.is_meeting_active());

        // Enter meeting
        state.set_meeting_active(true);
        assert!(state.is_meeting_active());

        // Leave meeting
        state.set_meeting_active(false);
        assert!(!state.is_meeting_active());
    }
}
