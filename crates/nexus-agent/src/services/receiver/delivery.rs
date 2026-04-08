//! Notification delivery orchestration
//!
//! Thin orchestrator that dispatches to focused modules:
//! - `desktop` — desktop notifications (macOS terminal-notifier / Linux notify-send)
//! - `audio` — audio playback and health probing
//! - `watch` — Apple Watch delivery via APNs
//! - `imessage` — iMessage delivery (macOS only)
//! - `tts_elevenlabs` — ElevenLabs TTS synthesis and error classification

use super::tts_elevenlabs::ElevenLabsClient;
use super::types::DeliveryResult;
use crate::config::NotificationsConfig;
use crate::services::receiver::service::{ReceiverService, SpeakRequest};
use anyhow::Result;
use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::fs;
use tracing::{debug, error, info, warn};

/// Session-scoped dedup flag for ElevenLabs failure alerts.
/// Resets on agent restart (process-level static). Ensures only the first
/// failure in a session triggers a desktop notification.
static ELEVENLABS_ALERT_SENT: AtomicBool = AtomicBool::new(false);

/// Attempt ElevenLabs TTS synthesis, write to temp file, and play.
/// Returns `Some(DeliveryResult::Played)` on success, `None` on failure
/// (caller should fall through to system TTS).
async fn try_elevenlabs_tts(
    formatted_message: &str,
    voice_id: &str,
    api_key: &str,
    config: &NotificationsConfig,
) -> Option<DeliveryResult> {
    info!("Generating TTS via ElevenLabs for: {:?}", formatted_message);
    match ReceiverService::generate_elevenlabs_audio(formatted_message, voice_id, api_key, config)
        .await
    {
        Ok(audio_data) => {
            let tmp_path = format!("/tmp/tts_{}.mp3", chrono::Utc::now().timestamp_millis());
            if let Err(e) = fs::write(&tmp_path, &audio_data).await {
                error!("Failed to write temp audio file: {}", e);
                return None;
            }
            info!("Playing ElevenLabs audio ({} bytes)", audio_data.len());
            match super::audio::play_audio_file(&tmp_path).await {
                Ok(()) => {
                    let _ = fs::remove_file(&tmp_path).await;
                    let _ = crate::claude_utils::notification_config::set_last_successful_play(
                        "elevenlabs",
                    );
                    Some(DeliveryResult::Played {
                        message: "Played via ElevenLabs".to_string(),
                        provider: "elevenlabs".to_string(),
                    })
                }
                Err(e) => {
                    warn!("Failed to play audio: {}", e);
                    let _ = fs::remove_file(&tmp_path).await;
                    None
                }
            }
        }
        Err(e) => {
            let error_str = e.to_string();
            warn!(
                "ElevenLabs failed: {}. Falling back to system TTS",
                error_str
            );

            // First-failure alert: notify user via desktop notification (once per session)
            if ELEVENLABS_ALERT_SENT
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let category = ElevenLabsClient::classify_error(&error_str);
                let alert_msg = format!(
                    "ElevenLabs {} — using system TTS. {}",
                    category.label, category.action
                );
                warn!("Sending ElevenLabs degradation alert to desktop");
                super::desktop::show_notification("Nexus TTS", &alert_msg, None).await;
            }
            None
        }
    }
}

impl ReceiverService {
    /// Generate TTS audio using ElevenLabs API
    pub(crate) async fn generate_elevenlabs_audio(
        text: &str,
        voice_id: &str,
        api_key: &str,
        config: &NotificationsConfig,
    ) -> Result<Vec<u8>, String> {
        let client = ElevenLabsClient::from_notifications_config(config, api_key.to_string());
        client.synthesize_with_voice(text, voice_id).await
    }

    /// Speak text using system TTS as fallback
    pub(crate) async fn speak_system_fallback(
        text: &str,
        voice: Option<&str>,
    ) -> Result<String, String> {
        super::SystemTts::speak(text, voice).await
    }

    /// Process speak request: try ElevenLabs, fallback to system TTS.
    /// Returns a typed `DeliveryResult` instead of a raw tuple.
    pub(crate) async fn process_speak_request(
        req: &SpeakRequest,
        config: &NotificationsConfig,
        mode: crate::claude_utils::notification_mode::NotificationMode,
    ) -> DeliveryResult {
        if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
            info!("Silent mode: skipping TTS in process_speak_request");
            return DeliveryResult::Skipped {
                reason: "Skipped (silent mode)".to_string(),
            };
        }

        let api_key = env::var("ELEVENLABS_API_KEY").ok();
        let voice_id = req
            .voice
            .clone()
            .or_else(|| {
                req.project.as_ref().map(|p| {
                    config
                        .project_voices
                        .get_voice_for_project(p, &config.elevenlabs.voice_id)
                        .to_string()
                })
            })
            .or_else(|| env::var("ELEVENLABS_VOICE_ID").ok())
            .unwrap_or_else(|| config.elevenlabs.voice_id.clone());

        let enriched = Self::enrich_vague_message(&req.message, req.project.as_deref());
        let formatted_message =
            Self::format_message_with_project(&enriched, req.project.as_deref());

        super::desktop::show_notification("Claude", &formatted_message, req.project.as_deref())
            .await;

        if let Some(project) = req.project.as_deref()
            && let Some(chime_path) = config.project_chimes.get_chime_for_project(project)
        {
            let expanded = crate::claude_utils::path::expand_home(chime_path);
            if expanded.exists() {
                debug!("Playing project chime for {}: {}", project, chime_path);
                if let Err(e) =
                    super::audio::play_audio_file(expanded.to_str().unwrap_or(chime_path)).await
                {
                    warn!("Failed to play chime: {}", e);
                }
            } else {
                debug!("Chime file not found: {}", expanded.display());
            }
        }

        // Try ElevenLabs (unless system mode or no key)
        if let Some(ref key) = api_key {
            if mode == crate::claude_utils::notification_mode::NotificationMode::System {
                debug!("System mode: skipping ElevenLabs, using system TTS directly");
            } else if let Some(result) =
                try_elevenlabs_tts(&formatted_message, &voice_id, key, config).await
            {
                return result;
            }
        } else {
            debug!("No ELEVENLABS_API_KEY set, using system TTS");
        }

        // System TTS fallback
        info!("Using system TTS for: {:?}", formatted_message);
        match Self::speak_system_fallback(&formatted_message, req.voice.as_deref()).await {
            Ok(provider) => {
                let _ =
                    crate::claude_utils::notification_config::set_last_successful_play(&provider);
                DeliveryResult::Played {
                    message: format!("Played via {}", provider),
                    provider,
                }
            }
            Err(e) => DeliveryResult::Failed { error: e },
        }
    }
}
