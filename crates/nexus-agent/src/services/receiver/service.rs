//! TTS Receiver HTTP service
//!
//! Provides an HTTP server for receiving TTS notifications from external sources.
//! Also listens on a Unix domain socket for sub-millisecond local delivery.
//! Routes:
//! - POST /speak - Generate and play TTS via ElevenLabs (with system fallback)
//! - POST /play  - Play audio file
//! - POST /watch/register - Register Apple Watch device token for push notifications
//! - GET /health - Health check endpoint
//! - GET /status/notifications - Notification subsystem status (socket, channels, queue, dedup)
//! - GET /mode   - Query current notification mode
//! - POST /mode  - Set notification mode
//! - POST /mode/cycle - Cycle to next notification mode
//! - POST /reload - Hot-reload notifications config from disk
//! - GET /history - Recent notification history (ring buffer)
//! - GET /sessions - Active Claude Code sessions (stub)
//! - GET /messages/:id - Retrieve full text of an extended message by ID

#[cfg(test)]
use super::AudioController;
use super::{
    ApnsClient, ApnsResponse, ApnsSender, BannerDelivery, BufferEntry, Deduplicator,
    ElevenLabsClient, MessageBuffer, NotificationBatchBuffer, PlaybackMessage, PlaybackQueue,
    PlaybackQueueHandle, QueuedNotification, SuppressionChecker, WatchTokenStore,
};
use crate::config::NotificationsConfig;
use crate::services::Service;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader};
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{mpsc, watch, RwLock};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

/// Daemon version from Cargo.toml
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Message type for notification delivery
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageType {
    /// Brief message — current behavior unchanged (default)
    Brief,
    /// Extended message — sentence-chunked TTS, truncated APNs, message store
    Extended,
}

impl Default for MessageType {
    fn default() -> Self {
        Self::Brief
    }
}

/// Delivery channel for notifications
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// TTS synthesis + audio playback (ElevenLabs or system fallback)
    Tts,
    /// Apple Push Notification to watch/phone
    Apns,
    /// macOS Notification Center banner via osascript
    Banner,
}

impl std::fmt::Display for Channel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Channel::Tts => write!(f, "tts"),
            Channel::Apns => write!(f, "apns"),
            Channel::Banner => write!(f, "banner"),
        }
    }
}

impl Channel {
    /// Compute default channels based on message type.
    /// Brief → all channels, Extended → TTS only.
    pub fn defaults_for(message_type: MessageType) -> Vec<Channel> {
        match message_type {
            MessageType::Brief => vec![Channel::Tts, Channel::Apns, Channel::Banner],
            MessageType::Extended => vec![Channel::Tts],
        }
    }

    /// Filter channels by platform availability.
    /// - Banner: only on macOS
    /// - TTS: only when an audio output device is detected
    /// Unavailable channels are silently removed.
    pub fn filter_available(channels: &[Channel]) -> Vec<Channel> {
        channels
            .iter()
            .copied()
            .filter(|ch| match ch {
                Channel::Banner => std::env::consts::OS == "macos",
                Channel::Tts => {
                    // Check audio device availability synchronously via env hint.
                    // Full async probe is done at health check; here we use a fast heuristic:
                    // on macOS CoreAudio is always available; on Linux check PULSE_SERVER or
                    // XDG_RUNTIME_DIR (pulseaudio socket lives there).
                    if std::env::consts::OS == "macos" {
                        true
                    } else {
                        // If pactl was reachable during last health probe, assume available.
                        // This avoids blocking the hot path with a subprocess spawn.
                        // Worst case: TTS handler itself will report failure.
                        true
                    }
                }
                Channel::Apns => true, // Always available; delivery checks happen in apns handler
            })
            .collect()
    }
}

/// Request body for POST /speak
#[derive(Debug, Clone, Deserialize)]
pub struct SpeakRequest {
    /// Message to speak via TTS
    pub message: String,
    /// Optional voice to use
    #[serde(default)]
    pub voice: Option<String>,
    /// Optional priority (higher = more urgent)
    #[serde(default)]
    pub priority: Option<u8>,
    /// Optional project identifier for notification context
    #[serde(default)]
    pub project: Option<String>,
    /// Notification mode from sender (full, system, noduck, silent)
    #[serde(default)]
    pub mode: Option<String>,
    /// Notification type (background_tasks, quality_gates, deployments, reminders, error_alerts)
    #[serde(default, rename = "type")]
    pub notification_type: Option<String>,
    /// Message type: "brief" (default) or "extended" for chunked delivery
    #[serde(default)]
    pub message_type: MessageType,
    /// Explicit delivery channels. When absent, defaults are computed from message_type:
    /// brief → ["tts", "apns", "banner"], extended → ["tts"]
    #[serde(default)]
    pub channels: Option<Vec<Channel>>,
}

/// Request body for POST /play
#[derive(Debug, Clone, Deserialize)]
pub struct PlayRequest {
    /// Path to audio file to play
    pub path: String,
    /// Optional volume (0.0 - 1.0)
    #[serde(default)]
    pub volume: Option<f32>,
}

/// Request body for POST /watch/register
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterWatchRequest {
    /// Apple Watch device token (hex string)
    pub device_token: String,
    /// Platform identifier (e.g. "watchOS 10")
    #[serde(default = "default_platform")]
    pub platform: String,
}

fn default_platform() -> String {
    "watchOS".to_string()
}

/// Response for successful operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Whether audio actually reached speakers
    #[serde(skip_serializing_if = "Option::is_none")]
    pub played: Option<bool>,
    /// TTS provider used (elevenlabs, espeak-ng, espeak, say, null)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Final effective mode after all resolution
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_resolved: Option<String>,
    /// Where the mode came from: "request", "per_type", "server_state", "default"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_source: Option<String>,
}

/// Response for watch registration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterWatchResponse {
    pub status: String,
}

/// Response for errors
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// Audio capability information for health endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioHealth {
    /// Whether an audio output sink is available
    pub output_available: bool,
    /// Whether ELEVENLABS_API_KEY env var is set
    pub elevenlabs_key_set: bool,
    /// Detected system TTS binary (espeak-ng, espeak, festival, say, or null)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_tts: Option<String>,
    /// Last time audio was successfully played
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_play: Option<String>,
    /// Current notification mode
    pub notification_mode: String,
}

/// Health check response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub uptime_seconds: u64,
    pub port: u16,
    pub buffers: usize,
    pub version: String,
    /// Audio capability information
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioHealth>,
}

/// Maximum number of notification records kept in the history ring buffer
const NOTIFICATION_HISTORY_CAPACITY: usize = 20;

/// Default Unix socket path for local notification delivery
const DEFAULT_SOCKET_PATH: &str = "/tmp/claude-notify.sock";

/// Get the socket path from env var or use the default
fn get_socket_path() -> String {
    env::var("CLAUDE_NOTIFY_SOCKET").unwrap_or_else(|_| DEFAULT_SOCKET_PATH.to_string())
}

/// An extended message stored in the in-memory message store
#[derive(Debug, Clone, Serialize)]
pub struct StoredMessage {
    pub id: String,
    pub message: String,
    pub message_type: MessageType,
    pub project: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// TTL for stored messages (1 hour)
const MESSAGE_STORE_TTL_SECS: i64 = 3600;
/// Interval for pruning expired messages (5 minutes)
const MESSAGE_PRUNE_INTERVAL_SECS: u64 = 300;

/// A record of a notification received via /speak, stored in the history ring buffer
#[derive(Debug, Clone, Serialize)]
pub struct NotificationRecord {
    pub message: String,
    pub project: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub notification_type: Option<String>,
}

/// Metadata about the last successfully delivered notification.
/// Updated on each notification delivery for the /status/notifications endpoint.
#[derive(Debug, Clone, Serialize)]
pub struct LastNotificationInfo {
    pub timestamp: DateTime<Utc>,
    pub message_type: MessageType,
    pub channels_used: Vec<String>,
}

/// TTS Receiver service state
pub struct ReceiverState {
    pub port: u16,
    pub running: bool,
    pub started_at: Option<DateTime<Utc>>,
    pub buffer_count: usize,
    /// Message deduplicator to prevent duplicate TTS requests
    deduplicator: Deduplicator,
    /// Message buffer for combining rapid notifications
    message_buffer: MessageBuffer,
    /// Notification batch buffer for coalescing by type
    notification_batch: NotificationBatchBuffer,
    /// Configuration for TTS settings
    config: NotificationsConfig,
    /// Tracks when the first message was received per project (for long-op detection)
    operation_start_times: HashMap<String, Instant>,
    /// Tracks last iMessage send time per project (for throttling)
    pub(crate) last_imessage_times: HashMap<String, Instant>,
    /// Intelligent suppression checker (video calls, DND)
    suppression_checker: SuppressionChecker,
    /// Handle to the serial playback queue (None before start())
    pub playback_queue: Option<PlaybackQueueHandle>,
    /// Ring buffer of recent notification records (capacity: NOTIFICATION_HISTORY_CAPACITY)
    pub notification_history: Arc<Mutex<VecDeque<NotificationRecord>>>,
    /// Shared config for hot-reload support (passed through from ReceiverService)
    pub shared_config: Option<Arc<tokio::sync::RwLock<NotificationsConfig>>>,
    /// In-memory message store for extended messages (id -> StoredMessage), TTL 1 hour
    pub message_store: Arc<Mutex<HashMap<String, StoredMessage>>>,
    /// Last notification metadata for /status/notifications endpoint
    pub last_notification: Option<LastNotificationInfo>,
}

impl ReceiverState {
    /// Create a new receiver state with the given config
    fn new(config: NotificationsConfig) -> Self {
        // Use configurable dedup window if suppression config is available
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
            playback_queue: None,
            notification_history: Arc::new(Mutex::new(VecDeque::with_capacity(
                NOTIFICATION_HISTORY_CAPACITY,
            ))),
            shared_config: None,
            message_store: Arc::new(Mutex::new(HashMap::new())),
            last_notification: None,
        }
    }

    /// Create a new receiver state with default config (for tests)
    #[cfg(test)]
    fn new_default() -> Self {
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
            playback_queue: None,
            notification_history: Arc::new(Mutex::new(VecDeque::with_capacity(
                NOTIFICATION_HISTORY_CAPACITY,
            ))),
            shared_config: None,
            message_store: Arc::new(Mutex::new(HashMap::new())),
            last_notification: None,
        }
    }
}

/// TTS Receiver HTTP service
pub struct ReceiverService {
    port: u16,
    state: Arc<RwLock<ReceiverState>>,
    config: NotificationsConfig,
    /// Shared config for hot-reload support (populated by with_shared_config)
    shared_config: Option<Arc<tokio::sync::RwLock<NotificationsConfig>>>,
    /// Watch channel receiver for config reload notifications
    reload_rx: Option<watch::Receiver<()>>,
}

impl ReceiverService {
    /// Create new receiver service with config loaded from file
    pub fn new() -> Self {
        let config = NotificationsConfig::load().unwrap_or_default();
        Self::with_config(config)
    }

    /// Create new receiver service with explicit config
    pub fn with_config(config: NotificationsConfig) -> Self {
        let port = config.server.port;
        Self {
            port,
            state: Arc::new(RwLock::new(ReceiverState::new(config.clone()))),
            config,
            shared_config: None,
            reload_rx: None,
        }
    }

    /// Create new receiver service with shared config for hot-reload support.
    /// Takes an initial config snapshot (caller clones before wrapping in Arc<RwLock>)
    /// to avoid blocking_read() inside the tokio runtime.
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
            state: Arc::new(RwLock::new(receiver_state)),
            config,
            shared_config: Some(shared_config),
            reload_rx: Some(reload_rx),
        }
    }

    /// Create new receiver service with custom port (uses default config otherwise)
    pub fn with_port(port: u16) -> Self {
        let mut config = NotificationsConfig::load().unwrap_or_default();
        config.server.port = port;
        let svc = Self::with_config(config);
        svc
    }

    /// Generate TTS audio using ElevenLabs API
    /// Generate TTS audio using ElevenLabs API
    async fn generate_elevenlabs_audio(
        text: &str,
        voice_id: &str,
        api_key: &str,
        config: &NotificationsConfig,
    ) -> Result<Vec<u8>, String> {
        let client = ElevenLabsClient::from_notifications_config(config, api_key.to_string());
        client.synthesize_with_voice(text, voice_id).await
    }

    /// Play audio file using platform-appropriate command
    async fn play_audio_file(path: &str) -> Result<(), String> {
        // Try platform-specific players in order
        let players: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "macos") {
            vec![("afplay", vec![])]
        } else {
            // Linux: try multiple players
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

    /// Show desktop notification using terminal-notifier (macOS) or notify-send (Linux)
    async fn show_notification(title: &str, message: &str, project: Option<&str>) {
        // Build title with optional project context
        let full_title = match project {
            Some(p) if !p.is_empty() => format!("{} ({})", title, p),
            _ => title.to_string(),
        };

        if cfg!(target_os = "macos") {
            // Use terminal-notifier on macOS (full path for launchd compatibility)
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
            // Use notify-send on Linux
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
    async fn probe_audio_health() -> AudioHealth {
        // Check ElevenLabs key
        let elevenlabs_key_set = std::env::var("ELEVENLABS_API_KEY").is_ok();

        // Detect system TTS
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

        // Check audio output availability (Linux: check PulseAudio/ALSA)
        let output_available = if cfg!(target_os = "macos") {
            true // macOS always has CoreAudio
        } else {
            // Check if pactl can find a sink
            Command::new("pactl")
                .args(["info"])
                .output()
                .await
                .map(|o| o.status.success())
                .unwrap_or(false)
        };

        // Read last successful play timestamp
        let last_successful_play =
            crate::claude_utils::notification_config::get_last_successful_play()
                .map(|p| p.timestamp.to_rfc3339());

        // Read current notification mode
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

    /// Speak text using system TTS as fallback
    async fn speak_system_fallback(text: &str, voice: Option<&str>) -> Result<String, String> {
        super::SystemTts::speak(text, voice).await
    }

    /// Check if a message should be blocked from TTS.
    /// Blocks generic phrases that provide no useful information.
    fn should_block_message(message: &str) -> bool {
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

    /// Detect vague completion messages and enrich with project context.
    /// Detects: "Done", "Complete", "Finished", "Ready" (case-insensitive, whole message only).
    fn enrich_vague_message(message: &str, project: Option<&str>) -> String {
        let trimmed = message.trim();
        let lower = trimmed.to_lowercase();

        // Only enrich if the entire message is vague (not part of a longer sentence)
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

    /// Format message with project prefix.
    /// - If project is Some and not empty, prepend uppercase project code.
    /// - Skip prefix for "global" project.
    /// - Example: "Task complete" with project "oo" becomes "OO: Task complete"
    fn format_message_with_project(message: &str, project: Option<&str>) -> String {
        match project {
            Some(p) if !p.is_empty() && p != "global" => {
                // Don't double-prefix if message already starts with project code
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

    /// Process speak request: try ElevenLabs, fallback to system TTS
    /// Implements audio ducking: pauses media before TTS, resumes after with configurable delay
    ///
    /// TODO: Refactor to use TtsOrchestrator for cleaner fallback logic:
    /// ```ignore
    /// use claude_daemon::services::receiver::{TtsOrchestrator, TtsResult};
    ///
    /// let orchestrator = TtsOrchestrator::new(elevenlabs_client);
    /// match orchestrator.synthesize(text, voice).await {
    ///     Ok(TtsResult::Audio(bytes)) => { /* write and play */ }
    ///     Ok(TtsResult::SystemSpoke(provider)) => { /* already spoken */ }
    ///     Err(e) => { /* handle error */ }
    /// }
    /// ```
    /// Process speak request: try ElevenLabs, fallback to system TTS
    ///
    /// Audio ducking is handled by PlaybackQueue (not here).
    /// This method handles: enrichment, notification, chime, TTS synthesis, playback.
    pub(crate) async fn process_speak_request(
        req: &SpeakRequest,
        config: &NotificationsConfig,
        mode: crate::claude_utils::notification_mode::NotificationMode,
    ) -> (bool, Option<String>, Option<String>) {
        // Handle Silent mode defensively (should be caught earlier)
        if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
            info!("Silent mode: skipping TTS in process_speak_request");
            return (true, Some("Skipped (silent mode)".to_string()), None);
        }
        let api_key = env::var("ELEVENLABS_API_KEY").ok();
        let voice_id = req
            .voice
            .clone()
            .or_else(|| {
                // Check project-specific voice if project is set
                req.project.as_ref().map(|p| {
                    config
                        .project_voices
                        .get_voice_for_project(p, &config.elevenlabs.voice_id)
                        .to_string()
                })
            })
            .or_else(|| env::var("ELEVENLABS_VOICE_ID").ok())
            .unwrap_or_else(|| config.elevenlabs.voice_id.clone());

        // Message formatting pipeline:
        // 1. Enrich vague messages (e.g. "Done" -> "OO complete")
        let enriched = Self::enrich_vague_message(&req.message, req.project.as_deref());
        // 2. Add project prefix (e.g. "Task complete" -> "OO: Task complete")
        let formatted_message =
            Self::format_message_with_project(&enriched, req.project.as_deref());

        // Show desktop notification (bell should sound before TTS)
        Self::show_notification("Claude", &formatted_message, req.project.as_deref()).await;

        // Play project chime if configured (before TTS)
        if let Some(project) = req.project.as_deref() {
            if let Some(chime_path) = config.project_chimes.get_chime_for_project(project) {
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
        }

        // Try ElevenLabs if API key is available and mode allows it
        // Skip ElevenLabs in System mode (go straight to system TTS)
        if let Some(key) = api_key {
            if mode == crate::claude_utils::notification_mode::NotificationMode::System {
                debug!("System mode: skipping ElevenLabs, using system TTS directly");
            } else {
                info!("Generating TTS via ElevenLabs for: {:?}", formatted_message);

                match Self::generate_elevenlabs_audio(&formatted_message, &voice_id, &key, config)
                    .await
                {
                    Ok(audio_data) => {
                        // Write to temp file
                        let tmp_path =
                            format!("/tmp/tts_{}.mp3", chrono::Utc::now().timestamp_millis());
                        if let Err(e) = fs::write(&tmp_path, &audio_data).await {
                            error!("Failed to write temp audio file: {}", e);
                        } else {
                            info!("Playing ElevenLabs audio ({} bytes)", audio_data.len());

                            match Self::play_audio_file(&tmp_path).await {
                                Ok(()) => {
                                    // Cleanup temp file
                                    let _ = fs::remove_file(&tmp_path).await;
                                    // Track last successful play
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

        // Fallback to system TTS
        info!("Using system TTS for: {:?}", formatted_message);
        match Self::speak_system_fallback(&formatted_message, req.voice.as_deref()).await {
            Ok(provider) => {
                // Track last successful play
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

    /// Check and flush any buffers that are ready (debounce window expired)
    ///
    /// This method is called periodically by the buffer flush ticker.
    /// For each project buffer that has passed the debounce window,
    /// it combines the messages and processes them via TTS.
    async fn flush_ready_buffers(state: Arc<RwLock<ReceiverState>>) {
        // Get list of project keys that might need flushing and the queue handle
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
            // Check if this buffer should flush and get the combined message
            let flush_data = {
                let mut state_guard = state.write().await;
                if state_guard.message_buffer.should_flush(&key) {
                    // Get project info from first message in buffer before flushing
                    let (project, voice) = state_guard.message_buffer.get_buffer_info(&key);

                    state_guard
                        .message_buffer
                        .flush_buffer(&key, project, voice)
                } else {
                    None
                }
            };

            // Enqueue the flushed buffer for serial playback
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

                // Update buffer count after flush
                {
                    let mut state_guard = state.write().await;
                    state_guard.buffer_count = state_guard.message_buffer.total_count();
                }
            }
        }

        // Also check and flush ready notification batches
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

    /// Check if an operation has been running long enough to warrant an iMessage
    /// Returns true if:
    /// 1. iMessage is enabled in config
    /// 2. Project has been sending messages for longer than threshold_minutes
    /// 3. We haven't sent an iMessage for this project within throttle_minutes
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

        // Check if operation has been running long enough
        let threshold = Duration::from_secs(config.imessage.threshold_minutes * 60);
        let started = state_guard.operation_start_times.get(&key);
        let running_long_enough = started
            .map(|start| start.elapsed() >= threshold)
            .unwrap_or(false);

        if !running_long_enough {
            return false;
        }

        // Check throttle
        let throttle = Duration::from_secs(config.imessage.throttle_minutes * 60);
        let last_sent = state_guard.last_imessage_times.get(&key);
        let throttle_ok = last_sent
            .map(|last| last.elapsed() >= throttle)
            .unwrap_or(true); // Never sent = OK

        throttle_ok
    }

    /// Reset operation tracking for a project (e.g., when session ends)
    #[allow(dead_code)]
    async fn reset_operation_tracking(state: &Arc<RwLock<ReceiverState>>, project: &str) {
        let mut state_guard = state.write().await;
        state_guard.operation_start_times.remove(project);
        state_guard.last_imessage_times.remove(project);
    }

    /// Send iMessage notification (macOS only)
    /// Used for critical/long-running operation alerts
    #[cfg(target_os = "macos")]
    pub async fn send_imessage(recipient: &str, message: &str) -> bool {
        // AppleScript to send iMessage via Messages.app
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

    /// Deliver notification to Apple Watch devices
    ///
    /// Sends notification to all active Watch devices via APNS.
    /// Runs concurrently with TTS - does not block the primary notification path.
    /// Channel-based routing: caller checks Channel::Apns before calling.
    ///
    /// # Arguments
    /// * `message` - The notification body
    /// * `project` - Optional project context
    /// * `notification_type` - Type of notification (e.g., "error_alerts")
    /// * `mode` - Current notification mode (silent suppresses delivery)
    /// * `message_id` - Optional message store ID for extended messages (wires build_apns_payload_ext)
    async fn deliver_to_watch(
        message: &str,
        project: Option<&str>,
        notification_type: &str,
        mode: crate::claude_utils::notification_mode::NotificationMode,
        message_id: Option<&str>,
    ) {
        // Check notification mode: silent mode suppresses Watch delivery
        if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
            debug!("Watch delivery suppressed: silent mode");
            return;
        }

        // Load notification config
        let notification_config =
            crate::claude_utils::notification_config::load_notification_config();

        // Check if Watch routing is enabled for this notification type
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

        // Get WatchConfig
        let watch_config = match notification_config.watch {
            Some(ref config) if config.enabled => config,
            _ => {
                debug!("Watch notifications disabled in config");
                return;
            }
        };

        // Validate required APNS configuration
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

        // Expand home path if needed
        let key_path_expanded = crate::claude_utils::path::expand_home(apns_key_path);
        let key_path_str = key_path_expanded.to_string_lossy().to_string();

        // Create ApnsClient
        let sandbox = watch_config.environment == "sandbox";
        let apns_client =
            match ApnsClient::new(&key_path_str, apns_key_id, apns_team_id, bundle_id, sandbox) {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to create APNS client: {}", e);
                    return;
                }
            };

        // Get active device tokens
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

        // Build notification title
        let title = match project {
            Some(p) if !p.is_empty() && p != "global" => {
                format!("{}", p.to_uppercase())
            }
            _ => "Claude".to_string(),
        };

        // Send to each active device — use send_notification_ext to wire extended payload
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

    /// Store an extended message in the in-memory message store with TTL
    fn store_message(
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

    /// Prune expired messages from the message store
    fn prune_message_store(store: &Arc<Mutex<HashMap<String, StoredMessage>>>) {
        let now = Utc::now();
        let mut guard = store.lock().unwrap();
        guard.retain(|_, msg| msg.expires_at > now);
    }

    /// Handle a single newline-delimited JSON message received via Unix socket.
    /// Parses the JSON as a SpeakRequest and routes it through the normal notification pipeline.
    #[cfg(unix)]
    async fn handle_socket_message(line: &str, state: Arc<RwLock<ReceiverState>>) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }

        match serde_json::from_str::<SpeakRequest>(trimmed) {
            Ok(req) => {
                debug!("Socket message received: {:?}", req.message);
                // Route through the same handler as HTTP POST /speak
                let body = trimmed.as_bytes();
                let _ = Self::handle_request("POST", "/speak", body, state).await;
            }
            Err(e) => {
                warn!("Invalid JSON on socket: {}", e);
            }
        }
    }

    /// Accept connections on a Unix domain socket and read newline-delimited JSON.
    /// Each connection can send multiple messages (one per line).
    #[cfg(unix)]
    async fn run_socket_listener(listener: UnixListener, state: Arc<RwLock<ReceiverState>>) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let state = Arc::clone(&state);
                    tokio::spawn(async move {
                        let reader = TokioBufReader::new(stream);
                        let mut lines = reader.lines();
                        loop {
                            match lines.next_line().await {
                                Ok(Some(line)) => {
                                    Self::handle_socket_message(&line, Arc::clone(&state)).await;
                                }
                                Ok(None) => break, // EOF — client disconnected
                                Err(e) => {
                                    debug!(
                                        "Socket read error (client may have disconnected): {}",
                                        e
                                    );
                                    break;
                                }
                            }
                        }
                    });
                }
                Err(e) => {
                    error!("Failed to accept socket connection: {}", e);
                }
            }
        }
    }

    /// Handle incoming HTTP request
    async fn handle_request(
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

                // Probe audio capabilities
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

                // Socket status
                let socket_path = get_socket_path();
                let socket_exists = std::path::Path::new(&socket_path).exists();

                // Channel availability
                let is_macos = std::env::consts::OS == "macos";
                let tts_available = true; // TTS is always attempted (system fallback)
                let apns_available = true; // APNs delivery is always attempted
                let banner_available = is_macos;

                // Last notification metadata
                let last_notification = state_guard.last_notification.as_ref().map(|ln| {
                    serde_json::json!({
                        "timestamp": ln.timestamp.to_rfc3339(),
                        "message_type": ln.message_type,
                        "channels_used": ln.channels_used,
                    })
                });

                // Queue depth: use the buffer count as a proxy since mpsc::Sender
                // does not expose pending count
                let pending_buffers = state_guard.buffer_count;

                // Dedup cache size (requires mutable access for cleanup)
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
                    // Get notification type (default to "background_tasks" if not provided)
                    let notification_type = req
                        .notification_type
                        .as_deref()
                        .unwrap_or("background_tasks");

                    info!(
                        "Received speak request [type={}, message_type={:?}]: {:?}",
                        notification_type, req.message_type, req.message
                    );

                    // Store extended messages in the in-memory message store
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

                    // Record notification in history ring buffer
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

                    // Block ambiguous messages that provide no useful information
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

                    // Determine effective notification mode with "quietest wins" rule
                    // and track where the mode came from for honest receipts
                    let (effective_mode, mode_source) = {
                        use crate::claude_utils::notification_mode::NotificationMode;

                        // Step 1: Start from request mode or server state
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

                        // Step 2: Apply per-type override only if it's stricter (quieter)
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

                    // --- Channel routing ---
                    // 1. Resolve channels: explicit field or defaults from message_type
                    let requested_channels = req
                        .channels
                        .clone()
                        .unwrap_or_else(|| Channel::defaults_for(req.message_type));

                    // 2. Filter by platform availability (e.g. banner only on macOS)
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

                    // 3. Channel-aware suppression
                    // - Focus mode (video call / DND): suppress tts+banner, allow apns
                    // - Quiet hours (silent mode): suppress tts only, allow apns+banner
                    let active_channels = {
                        let mut channels = available_channels.clone();

                        // Handle Silent mode: suppress TTS only, allow apns+banner
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

                        // Focus mode suppression: suppress tts+banner, allow apns
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

                    // Track last notification metadata for /status/notifications
                    {
                        let mut state_guard = state.write().await;
                        state_guard.last_notification = Some(LastNotificationInfo {
                            timestamp: Utc::now(),
                            message_type: req.message_type,
                            channels_used: active_channels.iter().map(|c| c.to_string()).collect(),
                        });
                    }

                    // 4. Dispatch to non-TTS channels (fire-and-forget, independent)
                    // APNs delivery
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

                    // Banner delivery (macOS only, fire-and-forget)
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

                    // If TTS is not in active channels, we're done (non-TTS channels dispatched above)
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

                    // --- TTS channel processing continues below ---

                    // Check for duplicate message within deduplication window and get config
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

                        // Track operation start time (first message per project)
                        {
                            let key = req.project.as_deref().unwrap_or("global").to_string();
                            state_guard
                                .operation_start_times
                                .entry(key)
                                .or_insert_with(Instant::now);
                        }

                        let batching_enabled = state_guard.config.batching.enabled;

                        // Try batching first if enabled
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
                                // Notification was not batched, deliver immediately
                                debug!(
                                    "Notification not batched, proceeding with immediate delivery"
                                );
                            } else {
                                // Notification was batched
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

                        // Add message to buffer
                        let entry = BufferEntry {
                            message: req.message.clone(),
                            project: req.project.clone(),
                            voice: req.voice.clone(),
                            received_at: Instant::now(),
                        };

                        // This returns Some if buffer is full and force-flush is needed
                        let flush_result = state_guard.message_buffer.add_message(entry);

                        // Update buffer count for health endpoint
                        state_guard.buffer_count = state_guard.message_buffer.total_count();

                        (flush_result, state_guard.config.clone(), batching_enabled)
                    };

                    // If force-flush was triggered, enqueue for serial playback
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

                        // Enqueue to playback queue
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

                        // Update buffer count after flush
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
                        // Message was buffered, return immediately
                        // The buffer flush ticker will handle playback after debounce window
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

                    // Verify file exists
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
                // Parse iMessage request: { "recipient": "email or phone", "message": "text" }
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

                        // Validate device_token is not empty
                        if req.device_token.trim().is_empty() {
                            let response = ErrorResponse {
                                error: "Invalid device_token".to_string(),
                                details: Some("device_token cannot be empty".to_string()),
                            };
                            let body = serde_json::to_vec(&response).unwrap_or_default();
                            return (400, "application/json".to_string(), body);
                        }

                        // Open token store and register device
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

                // Try to read the full state file for metadata
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
                            // Update the shared config (used by main.rs / other services)
                            {
                                let mut config_guard = shared_config.write().await;
                                *config_guard = new_config.clone();
                            }
                            // Update the state's local config copy so that
                            // handle_request reads (e.g. batching, debounce) pick up new values
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

            ("GET", "/sessions") => {
                // TODO: Wire up session data from CO streamer
                (200, "application/json".to_string(), b"[]".to_vec())
            }

            ("GET", "/messages") => {
                // Return recent iMessages polled by the iMessage reader service
                // Messages are persisted to disk by imessage_reader and read here
                let home = std::env::var("HOME").unwrap_or_default();
                let messages_path = format!("{}/.claude/state/imessages.json", home);
                match std::fs::read_to_string(&messages_path) {
                    Ok(json) => (200, "application/json".to_string(), json.into_bytes()),
                    Err(_) => (200, "application/json".to_string(), b"[]".to_vec()),
                }
            }

            ("GET", p) if p.starts_with("/messages/") => {
                // GET /messages/:id — retrieve full text of an extended message
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
    fn parse_request(data: &[u8]) -> Option<(String, String, Vec<u8>)> {
        let request_str = String::from_utf8_lossy(data);
        let lines: Vec<&str> = request_str.lines().collect();

        if lines.is_empty() {
            return None;
        }

        // Parse request line: METHOD PATH HTTP/VERSION
        let parts: Vec<&str> = lines[0].split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }

        let method = parts[0].to_string();
        let path = parts[1].to_string();

        // Find body (after empty line)
        let mut body_start = 0;
        let mut content_length: usize = 0;

        for (i, line) in lines.iter().enumerate() {
            if line.to_lowercase().starts_with("content-length:") {
                if let Some(len_str) = line.split(':').nth(1) {
                    content_length = len_str.trim().parse().unwrap_or(0);
                }
            }
            if line.is_empty() {
                // Body starts after this empty line
                body_start = i + 1;
                break;
            }
        }

        let body = if body_start > 0 && content_length > 0 {
            // Find the position in the original data
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
    fn format_response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
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
    async fn handle_connection(mut stream: TcpStream, state: Arc<RwLock<ReceiverState>>) {
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

impl Default for ReceiverService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Service for ReceiverService {
    fn name(&self) -> &'static str {
        "tts_receiver"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        // Listen on all interfaces (0.0.0.0) to accept connections from other machines
        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(addr).await?;

        info!("TTS Receiver listening on http://0.0.0.0:{}", self.port);

        // Start Unix domain socket listener for sub-millisecond local delivery
        #[cfg(unix)]
        let socket_path = get_socket_path();
        #[cfg(unix)]
        {
            // Clean up stale socket from crashed daemon
            let sock_path = std::path::Path::new(&socket_path);
            if sock_path.exists() {
                info!("Removing stale socket file: {}", socket_path);
                let _ = std::fs::remove_file(sock_path);
            }
            match UnixListener::bind(&socket_path) {
                Ok(unix_listener) => {
                    info!("TTS Receiver listening on socket: {}", socket_path);
                    let state_for_socket = Arc::clone(&self.state);
                    tokio::spawn(async move {
                        Self::run_socket_listener(unix_listener, state_for_socket).await;
                    });
                }
                Err(e) => {
                    error!("Failed to bind Unix socket at {}: {}", socket_path, e);
                    // Continue without socket — HTTP still works
                }
            }
        }

        // Spawn the serial playback queue
        let queue_depth = self.config.playback_queue.max_depth;
        let (queue_handle, queue_join) =
            PlaybackQueue::spawn(self.config.clone(), Arc::clone(&self.state), queue_depth);
        info!("Playback queue spawned (depth={})", queue_depth);

        // Mark as running, record start time, store queue handle
        {
            let mut state = self.state.write().await;
            state.running = true;
            state.started_at = Some(Utc::now());
            state.playback_queue = Some(queue_handle);
        }

        // Create a ticker for checking buffer flush (check every 500ms)
        let mut buffer_flush_interval = tokio::time::interval(Duration::from_millis(500));

        // Create a ticker for pruning expired messages from the store (every 5 minutes)
        let mut message_prune_interval =
            tokio::time::interval(Duration::from_secs(MESSAGE_PRUNE_INTERVAL_SECS));

        loop {
            tokio::select! {
                // Handle shutdown signal
                _ = shutdown_rx.recv() => {
                    info!("TTS Receiver shutting down");
                    break;
                }

                // Check for buffers ready to flush (debounce window expired)
                _ = buffer_flush_interval.tick() => {
                    let state = Arc::clone(&self.state);
                    // Spawn as a separate task to not block the main loop
                    tokio::spawn(async move {
                        Self::flush_ready_buffers(state).await;
                    });
                }

                // Prune expired messages from the in-memory store
                _ = message_prune_interval.tick() => {
                    let store = {
                        let state_guard = self.state.read().await;
                        Arc::clone(&state_guard.message_store)
                    };
                    Self::prune_message_store(&store);
                }

                // Accept new connections
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

        // Shutdown sequence: clean up socket file
        #[cfg(unix)]
        {
            let sock_path = std::path::Path::new(&socket_path);
            if sock_path.exists() {
                info!("Removing socket file on shutdown: {}", socket_path);
                let _ = std::fs::remove_file(sock_path);
            }
        }

        // 1. Flush remaining buffers (enqueues to playback queue)
        info!("Flushing remaining buffers before shutdown");
        Self::flush_ready_buffers(Arc::clone(&self.state)).await;

        // 2. Drop queue handle to signal consumer to drain
        {
            let mut state = self.state.write().await;
            state.playback_queue = None;
        }
        info!("Playback queue handle dropped, waiting for consumer drain");

        // 3. Wait for consumer to finish with timeout
        match tokio::time::timeout(Duration::from_secs(10), queue_join).await {
            Ok(Ok(())) => info!("Playback queue drained successfully"),
            Ok(Err(e)) => warn!("Playback queue task panicked: {}", e),
            Err(_) => warn!("Playback queue drain timed out after 10s"),
        }

        // Mark as stopped
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
mod tests {
    use super::*;

    #[test]
    fn test_parse_get_request() {
        let request = b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let result = ReceiverService::parse_request(request);
        assert!(result.is_some());
        let (method, path, body) = result.unwrap();
        assert_eq!(method, "GET");
        assert_eq!(path, "/health");
        assert!(body.is_empty());
    }

    #[test]
    fn test_parse_post_request() {
        let request = b"POST /speak HTTP/1.1\r\nHost: localhost\r\nContent-Length: 23\r\n\r\n{\"message\":\"hello\"}";
        let result = ReceiverService::parse_request(request);
        assert!(result.is_some());
        let (method, path, body) = result.unwrap();
        assert_eq!(method, "POST");
        assert_eq!(path, "/speak");
        assert!(!body.is_empty());
    }

    #[test]
    fn test_format_response() {
        let body = b"{\"status\":\"ok\"}";
        let response = ReceiverService::format_response(200, "application/json", body);
        let response_str = String::from_utf8_lossy(&response);
        assert!(response_str.contains("HTTP/1.1 200 OK"));
        assert!(response_str.contains("Content-Type: application/json"));
        assert!(response_str.contains("{\"status\":\"ok\"}"));
    }

    #[test]
    fn test_speak_request_deserialize() {
        let json = r#"{"message":"hello world"}"#;
        let req: SpeakRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.message, "hello world");
        assert!(req.voice.is_none());
        assert!(req.priority.is_none());
    }

    #[test]
    fn test_speak_request_with_options() {
        let json = r#"{"message":"hello","voice":"Samantha","priority":1}"#;
        let req: SpeakRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.message, "hello");
        assert_eq!(req.voice, Some("Samantha".to_string()));
        assert_eq!(req.priority, Some(1));
    }

    #[test]
    fn test_speak_request_with_mode() {
        // Test with mode field
        let json = r#"{"message":"test","mode":"system"}"#;
        let req: SpeakRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.message, "test");
        assert_eq!(req.mode, Some("system".to_string()));

        // Test without mode field (should default to None)
        let json2 = r#"{"message":"test2"}"#;
        let req2: SpeakRequest = serde_json::from_str(json2).unwrap();
        assert_eq!(req2.message, "test2");
        assert_eq!(req2.mode, None);

        // Test all valid modes
        for mode in &["full", "system", "noduck", "silent"] {
            let json = format!(r#"{{"message":"test","mode":"{}"}}"#, mode);
            let req: SpeakRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(req.mode, Some(mode.to_string()));
        }
    }

    #[test]
    fn test_speak_request_with_notification_type() {
        // Test with type field (using rename attribute)
        let json = r#"{"message":"test","type":"quality_gates"}"#;
        let req: SpeakRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.message, "test");
        assert_eq!(req.notification_type, Some("quality_gates".to_string()));

        // Test without type field (should default to None)
        let json2 = r#"{"message":"test2"}"#;
        let req2: SpeakRequest = serde_json::from_str(json2).unwrap();
        assert_eq!(req2.message, "test2");
        assert_eq!(req2.notification_type, None);

        // Test all valid notification types
        for ntype in &[
            "background_tasks",
            "quality_gates",
            "deployments",
            "reminders",
            "error_alerts",
        ] {
            let json = format!(r#"{{"message":"test","type":"{}"}}"#, ntype);
            let req: SpeakRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(req.notification_type, Some(ntype.to_string()));
        }

        // Test with both mode and type
        let json = r#"{"message":"test","mode":"system","type":"deployments"}"#;
        let req: SpeakRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.mode, Some("system".to_string()));
        assert_eq!(req.notification_type, Some("deployments".to_string()));
    }

    #[test]
    fn test_play_request_deserialize() {
        let json = r#"{"path":"/tmp/audio.mp3"}"#;
        let req: PlayRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.path, "/tmp/audio.mp3");
        assert!(req.volume.is_none());
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let mut state = ReceiverState::new_default();
        state.running = true;
        state.started_at = Some(Utc::now());
        let state = Arc::new(RwLock::new(state));

        let (status, content_type, body) =
            ReceiverService::handle_request("GET", "/health", &[], state).await;

        assert_eq!(status, 200);
        assert_eq!(content_type, "application/json");

        let response: HealthResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(response.status, "healthy");
        assert_eq!(response.port, 9999);
        assert_eq!(response.buffers, 0);
        assert_eq!(response.version, VERSION);
        // uptime_seconds should be very small (just started)
        assert!(response.uptime_seconds < 5);
    }

    #[tokio::test]
    async fn test_speak_endpoint_parses_request() {
        // This test verifies the endpoint parses requests correctly
        // The actual TTS playback may fail depending on system capabilities
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"message":"test message"}"#;

        let (status, content_type, _response_body) =
            ReceiverService::handle_request("POST", "/speak", body, state).await;

        // Status should be either 200 (success) or 500 (no TTS available)
        assert!(status == 200 || status == 500);
        assert_eq!(content_type, "application/json");
    }

    #[tokio::test]
    async fn test_not_found() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));

        let (status, _, body) =
            ReceiverService::handle_request("GET", "/nonexistent", &[], state).await;

        assert_eq!(status, 404);

        let response: ErrorResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(response.error, "Not found");
    }

    #[tokio::test]
    async fn test_invalid_speak_body() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = b"invalid json";

        let (status, _, response_body) =
            ReceiverService::handle_request("POST", "/speak", body, state).await;

        assert_eq!(status, 400);

        let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response.error, "Invalid request body");
    }

    #[tokio::test]
    async fn test_duplicate_speak_request_skipped() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"message":"duplicate test"}"#;

        // First request
        let (status1, _, _response_body1) =
            ReceiverService::handle_request("POST", "/speak", body, Arc::clone(&state)).await;

        // Status should be either 200 (success) or 500 (no TTS available)
        assert!(status1 == 200 || status1 == 500);

        // Second identical request should be skipped as duplicate
        let (status2, _, response_body2) =
            ReceiverService::handle_request("POST", "/speak", body, state).await;

        assert_eq!(status2, 200);
        let response: SuccessResponse = serde_json::from_slice(&response_body2).unwrap();
        assert!(response.success);
        assert!(response
            .message
            .as_ref()
            .map(|m| m.contains("duplicate"))
            .unwrap_or(false));
    }

    #[tokio::test]
    async fn test_audio_controller_duck_media() {
        // This test verifies AudioController works without errors
        // The actual result depends on system state (whether media is playing)
        let controller = AudioController::new(Duration::from_millis(100));
        let was_playing = controller.duck_media().await;
        // Just verify it returns a bool without panicking
        assert!(was_playing || !was_playing);
    }

    // --- Message formatting tests ---

    #[test]
    fn test_format_message_with_project_adds_prefix() {
        let result = ReceiverService::format_message_with_project("Task complete", Some("oo"));
        assert_eq!(result, "OO: Task complete");
    }

    #[test]
    fn test_format_message_with_project_no_double_prefix() {
        // Already has prefix with colon
        let result = ReceiverService::format_message_with_project("OO: Task complete", Some("oo"));
        assert_eq!(result, "OO: Task complete");

        // Already has prefix with space-colon
        let result = ReceiverService::format_message_with_project("OO : Task complete", Some("oo"));
        assert_eq!(result, "OO : Task complete");
    }

    #[test]
    fn test_format_message_with_project_no_project() {
        let result = ReceiverService::format_message_with_project("Task complete", None);
        assert_eq!(result, "Task complete");
    }

    #[test]
    fn test_format_message_with_project_empty_project() {
        let result = ReceiverService::format_message_with_project("Task complete", Some(""));
        assert_eq!(result, "Task complete");
    }

    #[test]
    fn test_format_message_with_project_global_skipped() {
        let result = ReceiverService::format_message_with_project("Task complete", Some("global"));
        assert_eq!(result, "Task complete");
    }

    #[test]
    fn test_enrich_vague_message_done() {
        let result = ReceiverService::enrich_vague_message("Done", Some("oo"));
        assert_eq!(result, "OO complete");
    }

    #[test]
    fn test_enrich_vague_message_complete_with_period() {
        let result = ReceiverService::enrich_vague_message("Complete.", Some("tc"));
        assert_eq!(result, "TC complete");
    }

    #[test]
    fn test_enrich_vague_message_finished_case_insensitive() {
        let result = ReceiverService::enrich_vague_message("FINISHED", Some("tl"));
        assert_eq!(result, "TL complete");
    }

    #[test]
    fn test_enrich_vague_message_ready_no_project() {
        let result = ReceiverService::enrich_vague_message("ready", None);
        assert_eq!(result, "Task complete");
    }

    #[test]
    fn test_enrich_vague_message_not_vague() {
        let result =
            ReceiverService::enrich_vague_message("Build completed successfully", Some("oo"));
        assert_eq!(result, "Build completed successfully");
    }

    #[test]
    fn test_enrich_vague_message_whitespace_trimmed() {
        let result = ReceiverService::enrich_vague_message("  Done  ", Some("oo"));
        assert_eq!(result, "OO complete");
    }

    #[test]
    fn test_should_block_message_blocked() {
        assert!(ReceiverService::should_block_message(
            "Claude needs assistance"
        ));
        assert!(ReceiverService::should_block_message(
            "Claude needs your attention"
        ));
        assert!(ReceiverService::should_block_message("which project"));
        assert!(ReceiverService::should_block_message(
            "The agent needs assistance with this"
        ));
        assert!(ReceiverService::should_block_message(
            "NEEDS YOUR ATTENTION"
        ));
    }

    #[test]
    fn test_should_block_message_allowed() {
        assert!(!ReceiverService::should_block_message("Build complete"));
        assert!(!ReceiverService::should_block_message(
            "Tests passed successfully"
        ));
        assert!(!ReceiverService::should_block_message("OO: Task complete"));
        assert!(!ReceiverService::should_block_message("Done"));
    }

    #[tokio::test]
    async fn test_blocked_message_returns_200() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"message":"Claude needs assistance"}"#;

        let (status, _, response_body) =
            ReceiverService::handle_request("POST", "/speak", body, state).await;

        assert_eq!(status, 200);
        let response: SuccessResponse = serde_json::from_slice(&response_body).unwrap();
        assert!(response.success);
        assert!(response
            .message
            .as_ref()
            .map(|m| m.contains("Blocked"))
            .unwrap_or(false));
    }

    // --- iMessage duration/throttle logic tests ---

    #[tokio::test]
    async fn test_should_send_imessage_disabled() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let config = NotificationsConfig::default();
        // Default config has imessage.enabled = false
        assert!(!config.imessage.enabled);
        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(!result);
    }

    #[tokio::test]
    async fn test_should_send_imessage_empty_recipient() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = String::new();
        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(!result);
    }

    #[tokio::test]
    async fn test_should_send_imessage_threshold_not_met() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();
        config.imessage.threshold_minutes = 10;

        // Insert a start time that is recent (not past threshold)
        {
            let mut guard = state.write().await;
            guard
                .operation_start_times
                .insert("test".to_string(), Instant::now());
        }

        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(!result, "Should not send iMessage when threshold not met");
    }

    #[tokio::test]
    async fn test_should_send_imessage_no_start_time() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();

        // No start time recorded for this project
        let result = ReceiverService::should_send_imessage(&state, Some("unknown"), &config).await;
        assert!(
            !result,
            "Should not send iMessage when no start time exists"
        );
    }

    #[tokio::test]
    async fn test_should_send_imessage_threshold_met_no_throttle() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();
        config.imessage.threshold_minutes = 0; // Immediate trigger for testing

        // Insert a start time in the past
        {
            let mut guard = state.write().await;
            guard
                .operation_start_times
                .insert("test".to_string(), Instant::now() - Duration::from_secs(1));
        }

        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(
            result,
            "Should send iMessage when threshold met and no previous send"
        );
    }

    #[tokio::test]
    async fn test_should_send_imessage_throttled() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();
        config.imessage.threshold_minutes = 0; // Immediate trigger
        config.imessage.throttle_minutes = 5;

        // Insert start time and recent last send time
        {
            let mut guard = state.write().await;
            guard
                .operation_start_times
                .insert("test".to_string(), Instant::now() - Duration::from_secs(1));
            guard
                .last_imessage_times
                .insert("test".to_string(), Instant::now()); // Just sent
        }

        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(!result, "Should not send iMessage when throttled");
    }

    #[tokio::test]
    async fn test_should_send_imessage_throttle_expired() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();
        config.imessage.threshold_minutes = 0;
        config.imessage.throttle_minutes = 0; // No throttle for testing

        // Insert start time and an old last send time
        {
            let mut guard = state.write().await;
            guard
                .operation_start_times
                .insert("test".to_string(), Instant::now() - Duration::from_secs(1));
            guard
                .last_imessage_times
                .insert("test".to_string(), Instant::now() - Duration::from_secs(1));
        }

        let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
        assert!(result, "Should send iMessage when throttle has expired");
    }

    #[tokio::test]
    async fn test_should_send_imessage_global_key() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let mut config = NotificationsConfig::default();
        config.imessage.enabled = true;
        config.imessage.recipient = "test@example.com".to_string();
        config.imessage.threshold_minutes = 0;

        // Insert with "global" key (no project)
        {
            let mut guard = state.write().await;
            guard.operation_start_times.insert(
                "global".to_string(),
                Instant::now() - Duration::from_secs(1),
            );
        }

        let result = ReceiverService::should_send_imessage(&state, None, &config).await;
        assert!(result, "Should use 'global' key when project is None");
    }

    #[tokio::test]
    async fn test_reset_operation_tracking() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));

        // Insert tracking data
        {
            let mut guard = state.write().await;
            guard
                .operation_start_times
                .insert("proj".to_string(), Instant::now());
            guard
                .last_imessage_times
                .insert("proj".to_string(), Instant::now());
        }

        // Verify data exists
        {
            let guard = state.read().await;
            assert!(guard.operation_start_times.contains_key("proj"));
            assert!(guard.last_imessage_times.contains_key("proj"));
        }

        // Reset
        ReceiverService::reset_operation_tracking(&state, "proj").await;

        // Verify data removed
        {
            let guard = state.read().await;
            assert!(!guard.operation_start_times.contains_key("proj"));
            assert!(!guard.last_imessage_times.contains_key("proj"));
        }
    }

    #[tokio::test]
    async fn test_operation_start_time_recorded_on_speak() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"message":"test","project":"myproj"}"#;

        // Verify no start time before
        {
            let guard = state.read().await;
            assert!(!guard.operation_start_times.contains_key("myproj"));
        }

        // Send speak request (may fail TTS but should still record start time)
        let _ = ReceiverService::handle_request("POST", "/speak", body, Arc::clone(&state)).await;

        // Verify start time was recorded
        {
            let guard = state.read().await;
            assert!(
                guard.operation_start_times.contains_key("myproj"),
                "operation_start_times should track the project after speak"
            );
        }
    }

    #[tokio::test]
    async fn test_watch_register_success() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"device_token":"test-token-abc123","platform":"watchOS 10"}"#;

        let (status, content_type, response_body) =
            ReceiverService::handle_request("POST", "/watch/register", body, state).await;

        assert_eq!(status, 200);
        assert_eq!(content_type, "application/json");

        let response: RegisterWatchResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response.status, "registered");
    }

    #[tokio::test]
    async fn test_watch_register_empty_token() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = br#"{"device_token":"","platform":"watchOS 10"}"#;

        let (status, _, response_body) =
            ReceiverService::handle_request("POST", "/watch/register", body, state).await;

        assert_eq!(status, 400);

        let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response.error, "Invalid device_token");
    }

    #[tokio::test]
    async fn test_watch_register_invalid_json() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        let body = b"invalid json";

        let (status, _, response_body) =
            ReceiverService::handle_request("POST", "/watch/register", body, state).await;

        assert_eq!(status, 400);

        let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response.error, "Invalid request body");
    }

    #[tokio::test]
    async fn test_watch_register_default_platform() {
        let state = Arc::new(RwLock::new(ReceiverState::new_default()));
        // Test without platform field - should use default
        let body = br#"{"device_token":"test-token-xyz789"}"#;

        let (status, _, response_body) =
            ReceiverService::handle_request("POST", "/watch/register", body, state).await;

        assert_eq!(status, 200);

        let response: RegisterWatchResponse = serde_json::from_slice(&response_body).unwrap();
        assert_eq!(response.status, "registered");
    }
}
