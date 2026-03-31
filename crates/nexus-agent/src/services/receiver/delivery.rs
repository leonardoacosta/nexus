//! Notification delivery mechanisms
//!
//! Contains: show_notification, deliver_to_watch, send_imessage,
//! generate_elevenlabs_audio, play_audio_file, speak_system_fallback,
//! probe_audio_health, process_speak_request.

use super::{
    ApnsClient, ApnsResponse, ApnsSender, ElevenLabsClient, WatchTokenStore,
};
use crate::config::NotificationsConfig;
use crate::services::receiver::service::{
    AudioHealth, ReceiverService, SpeakRequest,
};
use anyhow::Result;
use std::env;
use tokio::fs;
use tokio::process::Command;
use tracing::{debug, error, info, warn};

impl ReceiverService {
    /// Show desktop notification using terminal-notifier (macOS) or notify-send (Linux)
    pub(crate) async fn show_notification(_title: &str, message: &str, project: Option<&str>) {
        let (icon, name) =
            crate::claude_utils::project::get_project_display(project.unwrap_or(""));
        let full_title = format!("{} {}", icon, name);

        if cfg!(target_os = "macos") {
            let result = Command::new("/opt/homebrew/bin/terminal-notifier")
                .arg("-title")
                .arg(&full_title)
                .arg("-message")
                .arg(message)
                .arg("-sound")
                .arg("default")
                .output()
                .await;

            match result {
                Ok(output) if output.status.success() => {
                    info!("Desktop notification sent (bell)");
                }
                Ok(output) => {
                    info!(
                        "terminal-notifier failed: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    info!("terminal-notifier not found at /opt/homebrew/bin/terminal-notifier");
                }
                Err(e) => {
                    info!("terminal-notifier error: {}", e);
                }
            }
        } else {
            let result = Command::new("notify-send")
                .arg(&full_title)
                .arg(message)
                .output()
                .await;

            match result {
                Ok(output) if output.status.success() => {
                    debug!("Desktop notification sent via notify-send");
                }
                Ok(output) => {
                    debug!(
                        "notify-send failed: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    debug!("notify-send not installed, skipping desktop notification");
                }
                Err(e) => {
                    debug!("notify-send error: {}", e);
                }
            }
        }
    }

    /// Probe audio capabilities for health endpoint
    pub(crate) async fn probe_audio_health() -> AudioHealth {
        let elevenlabs_key_set = std::env::var("ELEVENLABS_API_KEY").is_ok();

        let system_tts = {
            let candidates = if cfg!(target_os = "macos") {
                vec!["say"]
            } else {
                vec!["espeak-ng", "espeak", "festival"]
            };

            let mut found = None;
            for cmd in candidates {
                if Command::new("which")
                    .arg(cmd)
                    .output()
                    .await
                    .map(|o| o.status.success())
                    .unwrap_or(false)
                {
                    found = Some(cmd.to_string());
                    break;
                }
            }
            found
        };

        let output_available = if cfg!(target_os = "macos") {
            true
        } else {
            Command::new("pactl")
                .args(["info"])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false)
        };

        let last_successful_play =
            crate::claude_utils::notification_config::get_last_successful_play()
                .map(|p| p.timestamp.to_rfc3339());

        let notification_mode =
            crate::claude_utils::notification_mode::get_notification_mode().to_string();

        AudioHealth {
            output_available,
            elevenlabs_key_set,
            system_tts,
            last_successful_play,
            notification_mode,
        }
    }

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

    /// Play audio file using platform-appropriate command
    pub(crate) async fn play_audio_file(path: &str) -> Result<(), String> {
        let players: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "macos") {
            vec![("afplay", vec![])]
        } else {
            vec![
                ("mpv", vec!["--no-video"]),
                ("ffplay", vec!["-nodisp", "-autoexit"]),
                ("paplay", vec![]),
                ("aplay", vec![]),
            ]
        };

        for (player, extra_args) in &players {
            let mut cmd = Command::new(player);
            cmd.args(extra_args);
            cmd.arg(path);

            let result = cmd.output().await;

            match result {
                Ok(output) if output.status.success() => {
                    return Ok(());
                }
                Ok(output) => {
                    debug!(
                        "{} failed: {}",
                        player,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    debug!("{} not found", player);
                }
                Err(e) => {
                    debug!("{} error: {}", player, e);
                }
            }
        }

        Err("No audio player available".to_string())
    }

    /// Speak text using system TTS as fallback
    pub(crate) async fn speak_system_fallback(
        text: &str,
        voice: Option<&str>,
    ) -> Result<String, String> {
        super::SystemTts::speak(text, voice).await
    }

    /// Process speak request: try ElevenLabs, fallback to system TTS
    pub(crate) async fn process_speak_request(
        req: &SpeakRequest,
        config: &NotificationsConfig,
        mode: crate::claude_utils::notification_mode::NotificationMode,
    ) -> (bool, Option<String>, Option<String>) {
        if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
            info!("Silent mode: skipping TTS in process_speak_request");
            return (true, Some("Skipped (silent mode)".to_string()), None);
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

        Self::show_notification("Claude", &formatted_message, req.project.as_deref()).await;

        if let Some(project) = req.project.as_deref()
            && let Some(chime_path) = config.project_chimes.get_chime_for_project(project) {
                let expanded = crate::claude_utils::path::expand_home(chime_path);
                if expanded.exists() {
                    debug!("Playing project chime for {}: {}", project, chime_path);
                    if let Err(e) =
                        Self::play_audio_file(expanded.to_str().unwrap_or(chime_path)).await
                    {
                        warn!("Failed to play chime: {}", e);
                    }
                } else {
                    debug!("Chime file not found: {}", expanded.display());
                }
            }

        if let Some(key) = api_key {
            if mode == crate::claude_utils::notification_mode::NotificationMode::System {
                debug!("System mode: skipping ElevenLabs, using system TTS directly");
            } else {
                info!("Generating TTS via ElevenLabs for: {:?}", formatted_message);
                match Self::generate_elevenlabs_audio(&formatted_message, &voice_id, &key, config)
                    .await
                {
                    Ok(audio_data) => {
                        let tmp_path =
                            format!("/tmp/tts_{}.mp3", chrono::Utc::now().timestamp_millis());
                        if let Err(e) = fs::write(&tmp_path, &audio_data).await {
                            error!("Failed to write temp audio file: {}", e);
                        } else {
                            info!("Playing ElevenLabs audio ({} bytes)", audio_data.len());
                            match Self::play_audio_file(&tmp_path).await {
                                Ok(()) => {
                                    let _ = fs::remove_file(&tmp_path).await;
                                    let _ =
                                        crate::claude_utils::notification_config::set_last_successful_play(
                                            "elevenlabs",
                                        );
                                    return (
                                        true,
                                        Some("Played via ElevenLabs".to_string()),
                                        Some("elevenlabs".to_string()),
                                    );
                                }
                                Err(e) => {
                                    warn!("Failed to play audio: {}", e);
                                    let _ = fs::remove_file(&tmp_path).await;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("ElevenLabs failed: {}. Falling back to system TTS", e);
                    }
                }
            }
        } else {
            debug!("No ELEVENLABS_API_KEY set, using system TTS");
        }

        info!("Using system TTS for: {:?}", formatted_message);
        match Self::speak_system_fallback(&formatted_message, req.voice.as_deref()).await {
            Ok(provider) => {
                let _ =
                    crate::claude_utils::notification_config::set_last_successful_play(&provider);
                (
                    true,
                    Some(format!("Played via {}", provider)),
                    Some(provider),
                )
            }
            Err(e) => (false, Some(e), None),
        }
    }

    /// Deliver notification to Apple Watch devices
    pub(crate) async fn deliver_to_watch(
        message: &str,
        project: Option<&str>,
        notification_type: &str,
        mode: crate::claude_utils::notification_mode::NotificationMode,
        message_id: Option<&str>,
    ) {
        if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
            debug!("Watch delivery suppressed: silent mode");
            return;
        }

        let notification_config =
            crate::claude_utils::notification_config::load_notification_config();

        if !crate::claude_utils::notification_config::should_route_to_watch(
            &notification_config,
            notification_type,
        ) {
            debug!(
                "Watch routing disabled for notification type: {}",
                notification_type
            );
            return;
        }

        let watch_config = match notification_config.watch {
            Some(ref config) if config.enabled => config,
            _ => {
                debug!("Watch notifications disabled in config");
                return;
            }
        };

        let apns_key_path = match &watch_config.apns_key_path {
            Some(path) => path,
            None => {
                warn!("Watch enabled but apns_key_path not configured");
                return;
            }
        };

        let apns_key_id = match &watch_config.apns_key_id {
            Some(id) => id,
            None => {
                warn!("Watch enabled but apns_key_id not configured");
                return;
            }
        };

        let apns_team_id = match &watch_config.apns_team_id {
            Some(id) => id,
            None => {
                warn!("Watch enabled but apns_team_id not configured");
                return;
            }
        };

        let bundle_id = match &watch_config.bundle_id {
            Some(id) => id,
            None => {
                warn!("Watch enabled but bundle_id not configured");
                return;
            }
        };

        let key_path_expanded = crate::claude_utils::path::expand_home(apns_key_path);
        let key_path_str = key_path_expanded.to_string_lossy().to_string();

        let sandbox = watch_config.environment == "sandbox";
        let apns_client =
            match ApnsClient::new(&key_path_str, apns_key_id, apns_team_id, bundle_id, sandbox) {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to create APNS client: {}", e);
                    return;
                }
            };

        let token_store = match WatchTokenStore::open() {
            Ok(store) => store,
            Err(e) => {
                warn!("Failed to open Watch token store: {}", e);
                return;
            }
        };

        let devices = match token_store.get_active_tokens() {
            Ok(tokens) => tokens,
            Err(e) => {
                warn!("Failed to get active Watch tokens: {}", e);
                return;
            }
        };

        if devices.is_empty() {
            debug!("No active Watch devices registered");
            return;
        }

        info!(
            "Delivering notification to {} Watch device(s) [type={}, message_id={:?}]",
            devices.len(),
            notification_type,
            message_id,
        );

        let (icon, name) =
            crate::claude_utils::project::get_project_display(project.unwrap_or(""));
        let title = format!("{} {}", icon, name);

        for device in devices {
            let result = apns_client
                .send_notification_ext(
                    &device.device_token,
                    &title,
                    message,
                    project,
                    Some(notification_type),
                    message_id,
                )
                .await;

            match result {
                Ok(ApnsResponse::Success) => {
                    info!(
                        "Watch notification delivered successfully to device: {}",
                        &device.device_token[..8]
                    );
                }
                Ok(ApnsResponse::TokenExpired) => {
                    warn!(
                        "Watch device token expired, invalidating: {}",
                        &device.device_token[..8]
                    );
                    if let Err(e) = token_store.invalidate_token(&device.device_token) {
                        error!("Failed to invalidate expired token: {}", e);
                    }
                }
                Ok(ApnsResponse::BadRequest(err)) => {
                    warn!(
                        "Watch notification failed (bad request) for device {}: {}",
                        &device.device_token[..8],
                        err
                    );
                }
                Ok(ApnsResponse::Error(err)) => {
                    warn!(
                        "Watch notification failed for device {}: {}",
                        &device.device_token[..8],
                        err
                    );
                }
                Err(e) => {
                    error!(
                        "Watch notification error for device {}: {}",
                        &device.device_token[..8],
                        e
                    );
                }
            }
        }
    }

    /// Send iMessage notification (macOS only)
    #[cfg(target_os = "macos")]
    pub async fn send_imessage(recipient: &str, message: &str) -> bool {
        let script = format!(
            r#"tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "{}" of targetService
    send "{}" to targetBuddy
end tell"#,
            recipient.replace('"', "\\\""),
            message.replace('"', "\\\"")
        );

        match Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                info!("Sent iMessage to {}: {}", recipient, message);
                true
            }
            Ok(output) => {
                warn!(
                    "iMessage failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                false
            }
            Err(e) => {
                warn!("Failed to execute iMessage AppleScript: {}", e);
                false
            }
        }
    }

    /// Send iMessage - stub for non-macOS platforms
    #[cfg(not(target_os = "macos"))]
    pub async fn send_imessage(_recipient: &str, _message: &str) -> bool {
        debug!("iMessage not supported on this platform");
        false
    }
}
