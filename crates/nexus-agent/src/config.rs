use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use tracing::{debug, info, warn};

/// Expand `~` to the user's home directory (inlined from claude_utils).
fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]);
        }
    }
    PathBuf::from(path)
}

/// Default config file path
const DEFAULT_CONFIG_PATH: &str = "~/.claude/scripts/notifications/config/notifications.json";

/// Server configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Port for the TTS receiver HTTP server
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self { port: 9999 }
    }
}

/// ElevenLabs TTS configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ElevenLabsConfig {
    /// ElevenLabs voice ID
    #[serde(rename = "voiceId")]
    pub voice_id: String,
    /// Voice name (for logging/display)
    #[serde(rename = "voiceName")]
    pub voice_name: Option<String>,
    /// ElevenLabs model ID
    #[serde(rename = "modelId")]
    pub model_id: String,
}

impl Default for ElevenLabsConfig {
    fn default() -> Self {
        Self {
            voice_id: "iNwc1Lv2YQLywnCvjfn1".to_string(),
            voice_name: Some("Roger".to_string()),
            model_id: "eleven_turbo_v2_5".to_string(),
        }
    }
}

/// Debounce configuration for message buffering
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DebounceConfig {
    /// Window in milliseconds to wait for additional messages
    #[serde(rename = "windowMs")]
    pub window_ms: u64,
    /// Maximum number of messages to buffer before force-flush
    #[serde(rename = "maxBuffer")]
    pub max_buffer: usize,
}

impl Default for DebounceConfig {
    fn default() -> Self {
        Self {
            window_ms: 2000,
            max_buffer: 5,
        }
    }
}

/// Audio playback configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    /// Delay in milliseconds before resuming media after TTS
    #[serde(rename = "resumeDelayMs")]
    pub resume_delay_ms: u64,
    /// Deduplication window in milliseconds
    #[serde(rename = "dedupWindowMs")]
    pub dedup_window_ms: u64,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            resume_delay_ms: 20,
            dedup_window_ms: 500,
        }
    }
}

/// Voice settings for ElevenLabs API
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct VoiceSettingsConfig {
    /// Voice stability (0.0 - 1.0)
    pub stability: f32,
    /// Voice similarity boost (0.0 - 1.0)
    #[serde(rename = "similarityBoost")]
    pub similarity_boost: f32,
    /// Playback speed (0.7 - 1.2)
    pub speed: f32,
}

impl Default for VoiceSettingsConfig {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
        }
    }
}

/// Per-project voice ID mapping
///
/// Maps project codes (e.g. "oo", "tc") to ElevenLabs voice IDs.
/// Falls back to "default" key, then to elevenlabs.voice_id.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ProjectVoicesConfig {
    #[serde(flatten)]
    pub voices: HashMap<String, String>,
}

impl Default for ProjectVoicesConfig {
    fn default() -> Self {
        Self {
            voices: HashMap::new(),
        }
    }
}

impl ProjectVoicesConfig {
    /// Get the voice ID for a given project.
    /// Falls back to the "default" key if the project has no specific mapping.
    /// Caller should provide the elevenlabs.voice_id as the ultimate fallback.
    pub fn get_voice_for_project<'a>(
        &'a self,
        project: &str,
        fallback_voice_id: &'a str,
    ) -> &'a str {
        self.voices
            .get(project)
            .or_else(|| self.voices.get("default"))
            .map(|s| s.as_str())
            .unwrap_or(fallback_voice_id)
    }
}

/// Per-project chime sound mapping
///
/// Maps project codes to chime audio file paths.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ProjectChimesConfig {
    #[serde(flatten)]
    pub chimes: HashMap<String, String>,
}

impl Default for ProjectChimesConfig {
    fn default() -> Self {
        Self {
            chimes: HashMap::new(),
        }
    }
}

impl ProjectChimesConfig {
    /// Get the chime path for a given project, if configured.
    pub fn get_chime_for_project(&self, project: &str) -> Option<&str> {
        self.chimes.get(project).map(|s| s.as_str())
    }
}

/// iMessage notification configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct IMessageConfig {
    /// Whether iMessage notifications are enabled
    pub enabled: bool,
    /// Minimum idle time (in minutes) before sending an iMessage
    #[serde(rename = "thresholdMinutes")]
    pub threshold_minutes: u64,
    /// Minimum time (in minutes) between iMessage notifications
    #[serde(rename = "throttleMinutes")]
    pub throttle_minutes: u64,
    /// iMessage recipient (email or phone number)
    pub recipient: String,
}

impl Default for IMessageConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_minutes: 10,
            throttle_minutes: 5,
            recipient: String::new(),
        }
    }
}

/// Notification batching configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct BatchingConfig {
    /// Whether batching is enabled
    pub enabled: bool,
    /// Window in milliseconds for coalescing build notifications
    #[serde(rename = "buildCoalesceWindowMs")]
    pub build_coalesce_window_ms: u64,
    /// Whether to coalesce reminder notifications
    #[serde(rename = "reminderCoalesce")]
    pub reminder_coalesce: bool,
    /// Whether focus session mode is active
    #[serde(rename = "focusSession")]
    pub focus_session: bool,
}

impl Default for BatchingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            build_coalesce_window_ms: 30000,
            reminder_coalesce: true,
            focus_session: false,
        }
    }
}

/// Playback queue configuration
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct PlaybackQueueConfig {
    /// Maximum number of messages that can be queued for playback
    #[serde(rename = "maxDepth")]
    pub max_depth: usize,
}

impl Default for PlaybackQueueConfig {
    fn default() -> Self {
        Self { max_depth: 50 }
    }
}

/// Root configuration structure
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct NotificationsConfig {
    /// Server settings
    pub server: ServerConfig,
    /// ElevenLabs TTS settings
    pub elevenlabs: ElevenLabsConfig,
    /// Debounce settings
    pub debounce: DebounceConfig,
    /// Audio playback settings
    pub audio: AudioConfig,
    /// Voice settings for TTS
    #[serde(rename = "voiceSettings")]
    pub voice_settings: VoiceSettingsConfig,
    /// Per-project voice ID mapping
    #[serde(rename = "projectVoices")]
    pub project_voices: ProjectVoicesConfig,
    /// Per-project chime sound mapping
    #[serde(rename = "projectChimes")]
    pub project_chimes: ProjectChimesConfig,
    /// iMessage notification settings
    #[serde(rename = "iMessage")]
    pub imessage: IMessageConfig,
    /// Notification batching settings
    pub batching: BatchingConfig,
    /// Playback queue settings
    #[serde(rename = "playbackQueue")]
    pub playback_queue: PlaybackQueueConfig,
}

impl NotificationsConfig {
    /// Load configuration from file with environment variable overrides
    ///
    /// Environment variables that override config:
    /// - `CLAUDE_RECEIVER_PORT`: Override server.port
    /// - `ELEVENLABS_VOICE_ID`: Override elevenlabs.voiceId
    /// - `ELEVENLABS_MODEL_ID`: Override elevenlabs.modelId
    /// - `CLAUDE_DEBOUNCE_WINDOW_MS`: Override debounce.windowMs
    /// - `CLAUDE_DEBOUNCE_MAX_BUFFER`: Override debounce.maxBuffer
    /// - `CLAUDE_AUDIO_RESUME_DELAY_MS`: Override audio.resumeDelayMs
    /// - `CLAUDE_AUDIO_DEDUP_WINDOW_MS`: Override audio.dedupWindowMs
    pub fn load() -> Result<Self> {
        let config_path = env::var("CLAUDE_NOTIFICATIONS_CONFIG")
            .unwrap_or_else(|_| DEFAULT_CONFIG_PATH.to_string());

        let expanded_path = expand_home(&config_path);

        let mut config = if expanded_path.exists() {
            info!("Loading config from: {}", expanded_path.display());
            let content = std::fs::read_to_string(&expanded_path).with_context(|| {
                format!("Failed to read config file: {}", expanded_path.display())
            })?;

            serde_json::from_str(&content).with_context(|| {
                format!("Failed to parse config file: {}", expanded_path.display())
            })?
        } else {
            warn!(
                "Config file not found at {}, using defaults",
                expanded_path.display()
            );
            Self::default()
        };

        config.apply_env_overrides();

        debug!("Loaded configuration: {:?}", config);
        Ok(config)
    }

    /// Apply environment variable overrides to the configuration
    fn apply_env_overrides(&mut self) {
        if let Ok(port_str) = env::var("CLAUDE_RECEIVER_PORT") {
            if let Ok(port) = port_str.parse::<u16>() {
                debug!("Overriding server.port from env: {}", port);
                self.server.port = port;
            }
        }

        if let Ok(voice_id) = env::var("ELEVENLABS_VOICE_ID") {
            debug!("Overriding elevenlabs.voiceId from env");
            self.elevenlabs.voice_id = voice_id;
        }

        if let Ok(model_id) = env::var("ELEVENLABS_MODEL_ID") {
            debug!("Overriding elevenlabs.modelId from env: {}", model_id);
            self.elevenlabs.model_id = model_id;
        }

        if let Ok(window_str) = env::var("CLAUDE_DEBOUNCE_WINDOW_MS") {
            if let Ok(window_ms) = window_str.parse::<u64>() {
                debug!("Overriding debounce.windowMs from env: {}", window_ms);
                self.debounce.window_ms = window_ms;
            }
        }

        if let Ok(max_str) = env::var("CLAUDE_DEBOUNCE_MAX_BUFFER") {
            if let Ok(max_buffer) = max_str.parse::<usize>() {
                debug!("Overriding debounce.maxBuffer from env: {}", max_buffer);
                self.debounce.max_buffer = max_buffer;
            }
        }

        if let Ok(delay_str) = env::var("CLAUDE_AUDIO_RESUME_DELAY_MS") {
            if let Ok(delay_ms) = delay_str.parse::<u64>() {
                debug!("Overriding audio.resumeDelayMs from env: {}", delay_ms);
                self.audio.resume_delay_ms = delay_ms;
            }
        }

        if let Ok(dedup_str) = env::var("CLAUDE_AUDIO_DEDUP_WINDOW_MS") {
            if let Ok(dedup_ms) = dedup_str.parse::<u64>() {
                debug!("Overriding audio.dedupWindowMs from env: {}", dedup_ms);
                self.audio.dedup_window_ms = dedup_ms;
            }
        }

        if let Ok(stability_str) = env::var("CLAUDE_VOICE_STABILITY") {
            if let Ok(stability) = stability_str.parse::<f32>() {
                if (0.0..=1.0).contains(&stability) {
                    debug!("Overriding voiceSettings.stability from env: {}", stability);
                    self.voice_settings.stability = stability;
                }
            }
        }

        if let Ok(boost_str) = env::var("CLAUDE_VOICE_SIMILARITY_BOOST") {
            if let Ok(boost) = boost_str.parse::<f32>() {
                if (0.0..=1.0).contains(&boost) {
                    debug!(
                        "Overriding voiceSettings.similarityBoost from env: {}",
                        boost
                    );
                    self.voice_settings.similarity_boost = boost;
                }
            }
        }
    }

    /// Get the deduplication window as a Duration
    pub fn dedup_window(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.audio.dedup_window_ms)
    }

    /// Get the debounce window as a Duration
    pub fn debounce_window(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.debounce.window_ms)
    }

    /// Get the resume delay as a Duration
    pub fn resume_delay(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.audio.resume_delay_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = NotificationsConfig::default();
        assert_eq!(config.server.port, 9999);
        assert_eq!(config.elevenlabs.voice_id, "iNwc1Lv2YQLywnCvjfn1");
        assert_eq!(config.elevenlabs.model_id, "eleven_turbo_v2_5");
        assert_eq!(config.debounce.window_ms, 2000);
        assert_eq!(config.debounce.max_buffer, 5);
        assert_eq!(config.audio.resume_delay_ms, 20);
        assert_eq!(config.audio.dedup_window_ms, 500);
        assert!((config.voice_settings.stability - 0.5).abs() < f32::EPSILON);
        assert!((config.voice_settings.similarity_boost - 0.75).abs() < f32::EPSILON);
    }

    #[test]
    fn test_parse_config_json() {
        let json = r#"{
            "server": {
                "port": 8080
            },
            "elevenlabs": {
                "voiceId": "test-voice-id",
                "voiceName": "Test Voice",
                "modelId": "eleven_test_model"
            },
            "debounce": {
                "windowMs": 5000,
                "maxBuffer": 10
            },
            "audio": {
                "resumeDelayMs": 1000,
                "dedupWindowMs": 20000
            },
            "voiceSettings": {
                "stability": 0.7,
                "similarityBoost": 0.8
            }
        }"#;

        let config: NotificationsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.server.port, 8080);
        assert_eq!(config.elevenlabs.voice_id, "test-voice-id");
        assert_eq!(config.elevenlabs.voice_name, Some("Test Voice".to_string()));
        assert_eq!(config.elevenlabs.model_id, "eleven_test_model");
        assert_eq!(config.debounce.window_ms, 5000);
        assert_eq!(config.debounce.max_buffer, 10);
        assert_eq!(config.audio.resume_delay_ms, 1000);
        assert_eq!(config.audio.dedup_window_ms, 20000);
        assert!((config.voice_settings.stability - 0.7).abs() < f32::EPSILON);
        assert!((config.voice_settings.similarity_boost - 0.8).abs() < f32::EPSILON);
    }

    #[test]
    fn test_partial_config_uses_defaults() {
        let json = r#"{
            "server": {
                "port": 7777
            }
        }"#;

        let config: NotificationsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.server.port, 7777);
        assert_eq!(config.elevenlabs.voice_id, "iNwc1Lv2YQLywnCvjfn1");
        assert_eq!(config.debounce.window_ms, 2000);
    }

    #[test]
    fn test_duration_helpers() {
        let config = NotificationsConfig::default();
        assert_eq!(config.dedup_window(), std::time::Duration::from_millis(500));
        assert_eq!(
            config.debounce_window(),
            std::time::Duration::from_millis(2000)
        );
        assert_eq!(config.resume_delay(), std::time::Duration::from_millis(20));
    }

    #[test]
    fn test_expand_home() {
        let expanded = expand_home("~/test/path");
        assert!(!expanded.to_string_lossy().contains("~"));

        let absolute = expand_home("/absolute/path");
        assert_eq!(absolute, std::path::PathBuf::from("/absolute/path"));
    }

    #[test]
    fn test_project_voices_config_default() {
        let config = ProjectVoicesConfig::default();
        assert!(config.voices.is_empty());
        assert_eq!(
            config.get_voice_for_project("oo", "fallback-id"),
            "fallback-id"
        );
    }

    #[test]
    fn test_project_voices_config_specific_project() {
        let mut voices = HashMap::new();
        voices.insert("default".to_string(), "default-voice".to_string());
        voices.insert("oo".to_string(), "oo-voice".to_string());
        let config = ProjectVoicesConfig { voices };

        assert_eq!(config.get_voice_for_project("oo", "fallback"), "oo-voice");
        assert_eq!(
            config.get_voice_for_project("tc", "fallback"),
            "default-voice"
        );
        assert_eq!(
            config.get_voice_for_project("unknown", "fallback"),
            "default-voice"
        );
    }

    #[test]
    fn test_project_voices_config_no_default_key() {
        let mut voices = HashMap::new();
        voices.insert("oo".to_string(), "oo-voice".to_string());
        let config = ProjectVoicesConfig { voices };

        assert_eq!(config.get_voice_for_project("oo", "fallback"), "oo-voice");
        assert_eq!(config.get_voice_for_project("tc", "fallback"), "fallback");
    }

    #[test]
    fn test_project_chimes_config_default() {
        let config = ProjectChimesConfig::default();
        assert!(config.chimes.is_empty());
        assert!(config.get_chime_for_project("oo").is_none());
    }

    #[test]
    fn test_project_chimes_config_with_entries() {
        let mut chimes = HashMap::new();
        chimes.insert("oo".to_string(), "/path/to/chime.wav".to_string());
        let config = ProjectChimesConfig { chimes };

        assert_eq!(
            config.get_chime_for_project("oo"),
            Some("/path/to/chime.wav")
        );
        assert!(config.get_chime_for_project("tc").is_none());
    }

    #[test]
    fn test_imessage_config_default() {
        let config = IMessageConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.threshold_minutes, 10);
        assert_eq!(config.throttle_minutes, 5);
        assert!(config.recipient.is_empty());
    }

    #[test]
    fn test_imessage_config_deserialize() {
        let json = r#"{
            "enabled": true,
            "thresholdMinutes": 15,
            "throttleMinutes": 3,
            "recipient": "user@example.com"
        }"#;

        let config: IMessageConfig = serde_json::from_str(json).unwrap();
        assert!(config.enabled);
        assert_eq!(config.threshold_minutes, 15);
        assert_eq!(config.throttle_minutes, 3);
        assert_eq!(config.recipient, "user@example.com");
    }

    #[test]
    fn test_full_config_with_new_sections() {
        let json = r#"{
            "server": { "port": 9999 },
            "elevenlabs": {
                "voiceId": "test-voice",
                "modelId": "eleven_turbo_v2_5"
            },
            "projectVoices": {
                "default": "default-voice-id",
                "oo": "oo-voice-id"
            },
            "projectChimes": {
                "tc": "/sounds/tc-chime.wav"
            },
            "iMessage": {
                "enabled": true,
                "thresholdMinutes": 20,
                "throttleMinutes": 10,
                "recipient": "test@test.com"
            }
        }"#;

        let config: NotificationsConfig = serde_json::from_str(json).unwrap();
        assert_eq!(
            config
                .project_voices
                .get_voice_for_project("oo", "fallback"),
            "oo-voice-id"
        );
        assert_eq!(
            config
                .project_voices
                .get_voice_for_project("tc", "fallback"),
            "default-voice-id"
        );
        assert_eq!(
            config.project_chimes.get_chime_for_project("tc"),
            Some("/sounds/tc-chime.wav")
        );
        assert!(config.project_chimes.get_chime_for_project("oo").is_none());
        assert!(config.imessage.enabled);
        assert_eq!(config.imessage.threshold_minutes, 20);
        assert_eq!(config.imessage.recipient, "test@test.com");
    }

    #[test]
    fn test_config_missing_new_sections_uses_defaults() {
        let json = r#"{
            "server": { "port": 9999 }
        }"#;

        let config: NotificationsConfig = serde_json::from_str(json).unwrap();
        assert!(config.project_voices.voices.is_empty());
        assert!(config.project_chimes.chimes.is_empty());
        assert!(!config.imessage.enabled);
        assert_eq!(config.imessage.threshold_minutes, 10);
    }
}
