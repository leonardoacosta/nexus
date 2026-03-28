//! Serial playback queue for TTS notifications
//!
//! Implements a tokio actor that consumes from a bounded mpsc channel,
//! guaranteeing serial audio playback. Between plays, pending messages
//! are drained and same-project items are coalesced using smart_combine().
//!
//! Key behaviors:
//! - Media ducking happens once per batch (duck before first, resume after last)
//! - Same-project messages that arrive during playback get coalesced
//! - Cross-project messages play in arrival order, never merged

use super::audio::AudioController;
use super::buffer::MessageBuffer;
use super::service::{MessageType, ReceiverService, ReceiverState, SpeakRequest};
use super::tts::split_into_chunks;
use crate::config::NotificationsConfig;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, RwLock};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// A message queued for serial playback
#[derive(Debug, Clone)]
pub struct PlaybackMessage {
    /// The speak request payload
    pub request: SpeakRequest,
    /// Resolved notification mode at enqueue time
    pub mode: crate::claude_utils::notification_mode::NotificationMode,
    /// When the message was queued (for FIFO ordering after coalescing)
    pub queued_at: Instant,
}

/// Cloneable handle for sending messages to the playback queue
#[derive(Clone)]
pub struct PlaybackQueueHandle {
    sender: mpsc::Sender<PlaybackMessage>,
}

impl PlaybackQueueHandle {
    /// Non-blocking enqueue. Logs if queue is full or closed.
    pub fn try_send(&self, msg: PlaybackMessage) {
        match self.sender.try_send(msg) {
            Ok(()) => debug!("Queued message for playback"),
            Err(mpsc::error::TrySendError::Full(_)) => {
                warn!("Playback queue full, dropping message");
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                warn!("Playback queue closed, dropping message");
            }
        }
    }
}

/// Serial playback queue actor
pub struct PlaybackQueue;

impl PlaybackQueue {
    /// Spawn the playback queue consumer task
    ///
    /// Creates a bounded channel and spawns a consumer task that processes
    /// messages serially. Returns a cloneable handle for sending messages
    /// and a JoinHandle for the consumer task.
    pub fn spawn(
        config: NotificationsConfig,
        state: Arc<RwLock<ReceiverState>>,
        max_depth: usize,
    ) -> (PlaybackQueueHandle, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel(max_depth);
        let handle = PlaybackQueueHandle { sender: tx };

        let join_handle = tokio::spawn(async move {
            Self::consumer_loop(rx, config, state).await;
        });

        (handle, join_handle)
    }

    /// Main consumer loop - processes messages serially with batched ducking
    ///
    /// Flow per batch:
    /// 1. recv() blocks for first message (None = shutdown)
    /// 2. Duck media once (respecting NoDuck mode)
    /// 3. Process first message via TTS
    /// 4. try_recv() drain loop - collect all pending messages
    /// 5. Group by project, coalesce with smart_combine
    /// 6. Process each coalesced group serially
    /// 7. Repeat drain loop until empty
    /// 8. Resume media once
    async fn consumer_loop(
        mut rx: mpsc::Receiver<PlaybackMessage>,
        config: NotificationsConfig,
        state: Arc<RwLock<ReceiverState>>,
    ) {
        info!("Playback queue consumer started");

        // Step 1: Block for first message (None = channel closed / shutdown)
        while let Some(first_msg) = rx.recv().await {
            // Step 2: Duck media once for this batch (respecting NoDuck mode)
            let audio_controller = AudioController::new(config.resume_delay());
            let was_playing = if first_msg.mode
                == crate::claude_utils::notification_mode::NotificationMode::NoDuck
            {
                debug!("NoDuck mode: skipping media ducking for batch");
                false
            } else {
                audio_controller.duck_media().await
            };

            // Step 3: Process the first message
            Self::process_single(&first_msg, &config, &state).await;

            // Steps 4-7: Drain and coalesce loop (repeat until empty)
            loop {
                let mut pending = Vec::new();
                while let Ok(msg) = rx.try_recv() {
                    pending.push(msg);
                }
                if pending.is_empty() {
                    break;
                }

                // Step 5: Group by project, coalesce with smart_combine
                let groups = Self::group_and_coalesce(pending);

                // Step 6: Process each coalesced group serially
                for msg in groups {
                    Self::process_single(&msg, &config, &state).await;
                }
                // Step 7: Loop back to drain again (catch messages that arrived during playback)
            }

            // Step 8: Resume media once for the whole batch
            if was_playing {
                audio_controller.resume_media().await;
            }
        }

        info!("Playback queue consumer shutting down (channel closed)");
    }

    /// Process a single playback message: TTS + iMessage escalation
    /// For extended messages, splits into sentence chunks and synthesizes sequentially.
    async fn process_single(
        msg: &PlaybackMessage,
        config: &NotificationsConfig,
        state: &Arc<RwLock<ReceiverState>>,
    ) {
        let (success, message, provider) = if msg.request.message_type == MessageType::Extended {
            // Extended message: sentence-chunked TTS synthesis
            Self::process_extended(msg, config).await
        } else {
            // Brief message: standard single-shot TTS
            ReceiverService::process_speak_request(&msg.request, config, msg.mode).await
        };

        if success {
            debug!(
                "Playback successful: {:?}, provider: {:?}",
                message, provider
            );

            // Check iMessage escalation for long-running operations
            if ReceiverService::should_send_imessage(state, msg.request.project.as_deref(), config)
                .await
            {
                let recipient = &config.imessage.recipient;
                let imsg = format!(
                    "{}: {}",
                    msg.request
                        .project
                        .as_deref()
                        .unwrap_or("Claude")
                        .to_uppercase(),
                    msg.request.message
                );
                info!("Sending iMessage to {} for long operation", recipient);
                let sent = ReceiverService::send_imessage(recipient, &imsg).await;
                if sent {
                    let key = msg
                        .request
                        .project
                        .as_deref()
                        .unwrap_or("global")
                        .to_string();
                    let mut state_guard = state.write().await;
                    state_guard.last_imessage_times.insert(key, Instant::now());
                }
            }
        } else {
            warn!("Playback failed: {:?}", message);
        }
    }

    /// Process an extended message: split into sentence chunks, synthesize and play each sequentially.
    /// Synthesize chunk N, play it, then synthesize chunk N+1, etc.
    async fn process_extended(
        msg: &PlaybackMessage,
        config: &NotificationsConfig,
    ) -> (bool, Option<String>, Option<String>) {
        let chunks = split_into_chunks(&msg.request.message);

        if chunks.is_empty() {
            return (true, Some("Empty extended message".to_string()), None);
        }

        info!(
            "Processing extended message: {} chunks from {} chars",
            chunks.len(),
            msg.request.message.len()
        );

        // For extended messages, we process each chunk as its own brief SpeakRequest
        // through the normal pipeline, which handles ElevenLabs/system TTS/playback
        let mut total_success = true;
        let mut last_provider = None;

        for (i, chunk) in chunks.iter().enumerate() {
            info!(
                "Playing chunk {}/{}: {} chars",
                i + 1,
                chunks.len(),
                chunk.len()
            );

            let chunk_req = SpeakRequest {
                message: chunk.clone(),
                voice: msg.request.voice.clone(),
                priority: msg.request.priority,
                project: msg.request.project.clone(),
                mode: msg.request.mode.clone(),
                notification_type: msg.request.notification_type.clone(),
                message_type: MessageType::Brief, // Each chunk is processed as brief
                channels: None,
            };

            let (success, _message, provider) =
                ReceiverService::process_speak_request(&chunk_req, config, msg.mode).await;

            if success {
                if let Some(ref p) = provider {
                    last_provider = Some(p.clone());
                }
            } else {
                warn!("Chunk {}/{} playback failed", i + 1, chunks.len());
                total_success = false;
                // Continue with remaining chunks even if one fails
            }
        }

        (
            total_success,
            Some(format!("Extended: {} chunks played", chunks.len())),
            last_provider,
        )
    }

    /// Group messages by project and coalesce same-project messages
    ///
    /// Returns a list of PlaybackMessages ordered by first arrival per project.
    /// Same-project messages are combined using smart_combine().
    /// Cross-project messages maintain their relative order.
    fn group_and_coalesce(messages: Vec<PlaybackMessage>) -> Vec<PlaybackMessage> {
        if messages.is_empty() {
            return Vec::new();
        }

        if messages.len() == 1 {
            return messages;
        }

        // Group by project key, tracking insertion order
        let mut groups: HashMap<String, Vec<PlaybackMessage>> = HashMap::new();
        let mut order: Vec<(String, Instant)> = Vec::new();

        for msg in messages {
            let key = msg
                .request
                .project
                .clone()
                .unwrap_or_else(|| "global".to_string());
            let entry = groups.entry(key.clone()).or_default();
            if entry.is_empty() {
                order.push((key, msg.queued_at));
            }
            entry.push(msg);
        }

        // Sort groups by first arrival (FIFO)
        order.sort_by_key(|(_, t)| *t);

        // Coalesce each group
        let mut result = Vec::new();
        for (key, _) in order {
            if let Some(mut msgs) = groups.remove(&key) {
                if msgs.len() == 1 {
                    result.push(msgs.remove(0));
                } else {
                    // Combine messages using smart_combine
                    let texts: Vec<String> =
                        msgs.iter().map(|m| m.request.message.clone()).collect();
                    let combined = MessageBuffer::smart_combine(&texts);

                    // Use first message as template for metadata
                    let first = &msgs[0];
                    result.push(PlaybackMessage {
                        request: SpeakRequest {
                            message: combined,
                            voice: first.request.voice.clone(),
                            priority: first.request.priority,
                            project: first.request.project.clone(),
                            mode: first.request.mode.clone(),
                            notification_type: first.request.notification_type.clone(),
                            message_type: first.request.message_type,
                            channels: first.request.channels.clone(),
                        },
                        mode: first.mode,
                        queued_at: first.queued_at,
                    });
                }
            }
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(message: &str, project: Option<&str>) -> PlaybackMessage {
        PlaybackMessage {
            request: SpeakRequest {
                message: message.to_string(),
                voice: None,
                priority: None,
                project: project.map(|s| s.to_string()),
                mode: None,
                notification_type: None,
                message_type: MessageType::Brief,
                channels: None,
            },
            mode: crate::claude_utils::notification_mode::NotificationMode::Full,
            queued_at: Instant::now(),
        }
    }

    #[test]
    fn test_coalesce_empty() {
        let result = PlaybackQueue::group_and_coalesce(vec![]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_coalesce_single() {
        let msgs = vec![make_msg("hello", Some("oo"))];
        let result = PlaybackQueue::group_and_coalesce(msgs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].request.message, "hello");
    }

    #[test]
    fn test_coalesce_same_project() {
        let msgs = vec![
            make_msg("first", Some("oo")),
            make_msg("second", Some("oo")),
        ];
        let result = PlaybackQueue::group_and_coalesce(msgs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].request.message, "first, and second");
        assert_eq!(result[0].request.project, Some("oo".to_string()));
    }

    #[test]
    fn test_coalesce_different_projects() {
        let msgs = vec![
            make_msg("oo msg", Some("oo")),
            make_msg("tc msg", Some("tc")),
        ];
        let result = PlaybackQueue::group_and_coalesce(msgs);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].request.message, "oo msg");
        assert_eq!(result[1].request.message, "tc msg");
    }

    #[test]
    fn test_coalesce_mixed_projects() {
        let msgs = vec![
            make_msg("oo first", Some("oo")),
            make_msg("tc msg", Some("tc")),
            make_msg("oo second", Some("oo")),
        ];
        let result = PlaybackQueue::group_and_coalesce(msgs);
        assert_eq!(result.len(), 2);
        // OO messages coalesced (appeared first)
        assert_eq!(result[0].request.message, "oo first, and oo second");
        // TC message separate
        assert_eq!(result[1].request.message, "tc msg");
    }

    #[test]
    fn test_coalesce_global_project() {
        let msgs = vec![
            make_msg("global first", None),
            make_msg("global second", None),
        ];
        let result = PlaybackQueue::group_and_coalesce(msgs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].request.message, "global first, and global second");
    }

    #[test]
    fn test_handle_try_send() {
        let (tx, _rx) = mpsc::channel(10);
        let handle = PlaybackQueueHandle { sender: tx };
        let msg = make_msg("test", None);
        handle.try_send(msg); // Should not panic
    }

    #[test]
    fn test_handle_try_send_closed() {
        let (tx, rx) = mpsc::channel(1);
        drop(rx); // Close the receiver
        let handle = PlaybackQueueHandle { sender: tx };
        let msg = make_msg("test", None);
        handle.try_send(msg); // Should log warning, not panic
    }
}
