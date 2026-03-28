// Notification configuration management module
//
// This module provides read/write access to the extended notifications.json config
// with full backward compatibility for existing configurations.
//
// # Example
//
// ```no_run
// use claude_utils::notification_config::{load_notification_config, get_type_mode};
//
// let config = load_notification_config();
// let mode = get_type_mode(&config, "quality_gates");
// ```

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use super::notification_mode::NotificationMode;
use super::path::expand_home;

/// Server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 9999,
        }
    }
}

/// ElevenLabs API configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ElevenLabsConfig {
    pub voice_id: String,
    pub model_id: String,
}

impl Default for ElevenLabsConfig {
    fn default() -> Self {
        Self {
            voice_id: "pNInz6obpgDQGcFmaJgB".to_string(),
            model_id: "eleven_monolingual_v1".to_string(),
        }
    }
}

/// Debounce/deduplication configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DebounceConfig {
    pub window_ms: u64,
    pub dedup_window_ms: u64,
}

impl Default for DebounceConfig {
    fn default() -> Self {
        Self {
            window_ms: 4000,
            dedup_window_ms: 10000,
        }
    }
}

/// Audio playback configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    pub duck_media: bool,
    pub resume_delay_ms: u64,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            duck_media: true,
            resume_delay_ms: 500,
        }
    }
}

/// iMessage configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IMessageConfig {
    pub enabled: bool,
    #[serde(rename = "thresholdMinutes")]
    pub threshold_minutes: u64,
    #[serde(rename = "throttleMinutes")]
    pub throttle_minutes: u64,
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

/// Per-notification-type configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TypeConfig {
    /// Notification mode override (null means use global default)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<NotificationMode>,
}

/// Suppression rules configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SuppressionConfig {
    pub video_call_detection: bool,
    pub dnd_detection: bool,
    pub dedup_window_ms: u64,
}

impl Default for SuppressionConfig {
    fn default() -> Self {
        Self {
            video_call_detection: true,
            dnd_detection: true,
            dedup_window_ms: 10000,
        }
    }
}

/// Batching/coalescing configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BatchingConfig {
    pub enabled: bool,
    pub build_coalesce_window_ms: u64,
    pub reminder_coalesce: bool,
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

/// ElevenLabs usage tier - maps priority levels to notification types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TierConfig {
    /// Critical types get ElevenLabs until 100% cap
    pub critical: Vec<String>,
    /// High priority types get ElevenLabs until 90% cap
    pub high: Vec<String>,
    /// Normal types get ElevenLabs until 80% cap
    pub normal: Vec<String>,
}

impl Default for TierConfig {
    fn default() -> Self {
        Self {
            critical: vec!["error_alerts".to_string()],
            high: vec!["quality_gates".to_string(), "deployments".to_string()],
            normal: vec!["reminders".to_string(), "background_tasks".to_string()],
        }
    }
}

/// Cost tracking configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CostConfig {
    pub track_elevenlabs: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_daily_elevenlabs: Option<f64>,
    pub cost_per_100_chars: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiers: Option<TierConfig>,
}

impl Default for CostConfig {
    fn default() -> Self {
        Self {
            track_elevenlabs: true,
            max_daily_elevenlabs: None,
            cost_per_100_chars: 0.003,
            tiers: None,
        }
    }
}

fn default_apns_environment() -> String {
    "sandbox".to_string()
}

/// Apple Watch notification configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchConfig {
    /// Whether Watch notifications are enabled
    #[serde(default)]
    pub enabled: bool,

    /// Path to APNS .p8 private key file
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apns_key_path: Option<String>,

    /// APNS Key ID (10 chars)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apns_key_id: Option<String>,

    /// Apple Developer Team ID (10 chars)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apns_team_id: Option<String>,

    /// Watch app bundle ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,

    /// APNS environment: "sandbox" or "production"
    #[serde(default = "default_apns_environment")]
    pub environment: String,

    /// Per-type routing to Watch: which types get pushed
    #[serde(default)]
    pub routing: HashMap<String, bool>,
}

impl Default for WatchConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            apns_key_path: None,
            apns_key_id: None,
            apns_team_id: None,
            bundle_id: None,
            environment: default_apns_environment(),
            routing: HashMap::new(),
        }
    }
}

/// Main notification configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<ServerConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub elevenlabs: Option<ElevenLabsConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub debounce: Option<DebounceConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioConfig>,

    #[serde(rename = "projectVoices")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_voices: Option<HashMap<String, String>>,

    #[serde(rename = "projectChimes")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_chimes: Option<HashMap<String, String>>,

    #[serde(rename = "iMessage")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imessage: Option<IMessageConfig>,

    // NEW sections (all optional with defaults)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub types: Option<HashMap<String, TypeConfig>>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub suppression: Option<SuppressionConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub batching: Option<BatchingConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<CostConfig>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch: Option<WatchConfig>,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            server: Some(ServerConfig::default()),
            elevenlabs: Some(ElevenLabsConfig::default()),
            debounce: Some(DebounceConfig::default()),
            audio: Some(AudioConfig::default()),
            project_voices: Some(HashMap::new()),
            project_chimes: Some(HashMap::new()),
            imessage: Some(IMessageConfig::default()),
            types: None,
            suppression: None,
            batching: None,
            cost: None,
            watch: None,
        }
    }
}

/// Returns the path to the last-audio-play.json state file
const LAST_AUDIO_PLAY_STATE: &str = "~/.claude/scripts/state/last-audio-play.json";

/// Last successful audio playback tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastAudioPlay {
    pub timestamp: DateTime<Utc>,
    pub provider: String, // "elevenlabs", "espeak-ng", "espeak", "say"
}

/// Returns the path to the notifications.json config file
pub fn notification_config_path() -> PathBuf {
    let home = env!("HOME");
    PathBuf::from(home)
        .join(".claude")
        .join("scripts")
        .join("notifications")
        .join("config")
        .join("notifications.json")
}

/// Returns the path to the last-audio-play.json state file
pub fn last_audio_play_path() -> PathBuf {
    expand_home(LAST_AUDIO_PLAY_STATE)
}

/// Load notification configuration from disk.
/// Returns default config if file doesn't exist or parsing fails.
pub fn load_notification_config() -> NotificationConfig {
    let path = notification_config_path();

    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(config) => config,
            Err(e) => {
                eprintln!("Failed to parse notification config: {}", e);
                NotificationConfig::default()
            }
        },
        Err(_) => {
            // File doesn't exist or can't be read, return defaults
            NotificationConfig::default()
        }
    }
}

/// Save notification configuration to disk with atomic write.
/// Writes to a temporary file first, then renames to avoid corruption.
pub fn save_notification_config(config: &NotificationConfig) -> Result<()> {
    let path = notification_config_path();

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Failed to create notification config directory")?;
    }

    // Serialize to pretty JSON
    let json =
        serde_json::to_string_pretty(config).context("Failed to serialize notification config")?;

    // Atomic write: write to temp file, then rename
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).context("Failed to write temporary config file")?;

    fs::rename(&temp_path, &path).context("Failed to rename config file")?;

    Ok(())
}

/// Get the notification mode for a specific notification type.
/// Returns the per-type override if set, None if using global default.
///
/// # Arguments
/// * `config` - The notification configuration
/// * `notification_type` - The type of notification (e.g., "quality_gates", "deployments")
///
/// # Returns
/// * `Some(mode)` - If a specific mode is configured for this type
/// * `None` - If this type should use the global default
pub fn get_type_mode(
    config: &NotificationConfig,
    notification_type: &str,
) -> Option<NotificationMode> {
    config
        .types
        .as_ref()
        .and_then(|types| types.get(notification_type))
        .and_then(|type_config| type_config.mode)
}

/// Check if a notification type should be routed to Watch
/// Default: only error_alerts and deployments
///
/// # Arguments
/// * `config` - The notification configuration
/// * `notification_type` - The type of notification (e.g., "error_alerts", "deployments")
///
/// # Returns
/// * `true` - If this notification type should be routed to Watch
/// * `false` - If Watch is disabled or this type should not be routed
pub fn should_route_to_watch(config: &NotificationConfig, notification_type: &str) -> bool {
    match &config.watch {
        Some(watch) if watch.enabled => {
            watch
                .routing
                .get(notification_type)
                .copied()
                .unwrap_or_else(|| {
                    // Default routing
                    matches!(notification_type, "error_alerts" | "deployments")
                })
        }
        _ => false,
    }
}

/// Get the ElevenLabs usage threshold for a notification type.
/// Returns the percentage (0.0-1.0) at which this type should stop using ElevenLabs.
///
/// - Critical types: use ElevenLabs up to 100% of daily cap
/// - High types: use ElevenLabs up to 90% of daily cap
/// - Normal types: use ElevenLabs up to 80% of daily cap
/// - Unknown types: treated as normal (80%)
///
/// # Arguments
/// * `config` - The notification configuration
/// * `notification_type` - The type of notification (e.g., "quality_gates", "deployments")
///
/// # Returns
/// * Threshold percentage (0.0-1.0) at which to stop using ElevenLabs for this type
pub fn get_elevenlabs_threshold(config: &NotificationConfig, notification_type: &str) -> f64 {
    let tiers = config.cost.as_ref().and_then(|c| c.tiers.as_ref());

    match tiers {
        Some(t) => {
            if t.critical.iter().any(|s| s == notification_type) {
                1.0
            } else if t.high.iter().any(|s| s == notification_type) {
                0.9
            } else if t.normal.iter().any(|s| s == notification_type) {
                0.8
            } else {
                0.8 // default to normal tier
            }
        }
        None => {
            // No tier config — use hardcoded defaults
            match notification_type {
                "error_alerts" => 1.0,
                "quality_gates" | "deployments" => 0.9,
                _ => 0.8,
            }
        }
    }
}

/// Read last successful audio play timestamp from state file
/// Returns None if file missing or unreadable
pub fn get_last_successful_play() -> Option<LastAudioPlay> {
    let path = last_audio_play_path();

    match fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<LastAudioPlay>(&contents) {
            Ok(play) => Some(play),
            Err(e) => {
                eprintln!("Failed to parse last audio play state: {}", e);
                None
            }
        },
        Err(_) => {
            // File doesn't exist or can't be read
            None
        }
    }
}

/// Write last successful audio play timestamp atomically
pub fn set_last_successful_play(provider: &str) -> Result<()> {
    let path = last_audio_play_path();

    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Failed to create state directory")?;
    }

    let play = LastAudioPlay {
        timestamp: Utc::now(),
        provider: provider.to_string(),
    };

    // Serialize to JSON
    let json =
        serde_json::to_string_pretty(&play).context("Failed to serialize last audio play")?;

    // Atomic write: write to temp file, then rename
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).context("Failed to write temporary state file")?;

    fs::rename(&temp_path, &path).context("Failed to atomically replace state file")?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_defaults() {
        let config = NotificationConfig::default();

        assert!(config.server.is_some());
        assert_eq!(config.server.as_ref().unwrap().port, 9999);
        assert!(config.elevenlabs.is_some());
        assert!(config.types.is_none());
        assert!(config.suppression.is_none());
    }

    #[test]
    fn test_serialize_minimal() {
        let config = NotificationConfig {
            server: Some(ServerConfig::default()),
            elevenlabs: None,
            debounce: None,
            audio: None,
            project_voices: None,
            project_chimes: None,
            imessage: None,
            types: None,
            suppression: None,
            batching: None,
            cost: None,
            watch: None,
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("server"));
        assert!(!json.contains("types"));
    }

    #[test]
    fn test_deserialize_legacy() {
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            },
            "elevenlabs": {
                "voice_id": "pNInz6obpgDQGcFmaJgB",
                "model_id": "eleven_monolingual_v1"
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.server.is_some());
        assert!(config.elevenlabs.is_some());
        assert!(config.types.is_none());
    }

    #[test]
    fn test_deserialize_with_types() {
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            },
            "types": {
                "quality_gates": {
                    "mode": "system"
                },
                "deployments": {
                    "mode": "full"
                }
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.types.is_some());

        let types = config.types.as_ref().unwrap();
        assert_eq!(types.len(), 2);
        assert_eq!(
            types.get("quality_gates").unwrap().mode,
            Some(NotificationMode::System)
        );
    }

    #[test]
    fn test_get_type_mode_with_override() {
        let mut types = HashMap::new();
        types.insert(
            "quality_gates".to_string(),
            TypeConfig {
                mode: Some(NotificationMode::System),
            },
        );

        let config = NotificationConfig {
            types: Some(types),
            ..Default::default()
        };

        let mode = get_type_mode(&config, "quality_gates");
        assert_eq!(mode, Some(NotificationMode::System));
    }

    #[test]
    fn test_get_type_mode_no_override() {
        let config = NotificationConfig::default();

        let mode = get_type_mode(&config, "quality_gates");
        assert_eq!(mode, None);
    }

    #[test]
    fn test_get_type_mode_missing_type() {
        let mut types = HashMap::new();
        types.insert(
            "deployments".to_string(),
            TypeConfig {
                mode: Some(NotificationMode::Full),
            },
        );

        let config = NotificationConfig {
            types: Some(types),
            ..Default::default()
        };

        let mode = get_type_mode(&config, "quality_gates");
        assert_eq!(mode, None);
    }

    #[test]
    fn test_type_config_null_mode() {
        let json = r#"{
            "types": {
                "background_tasks": {
                    "mode": null
                }
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        let mode = get_type_mode(&config, "background_tasks");
        assert_eq!(mode, None);
    }

    #[test]
    fn test_round_trip_serialization() {
        let mut types = HashMap::new();
        types.insert(
            "quality_gates".to_string(),
            TypeConfig {
                mode: Some(NotificationMode::NoDuck),
            },
        );

        let original = NotificationConfig {
            server: Some(ServerConfig::default()),
            types: Some(types),
            suppression: Some(SuppressionConfig::default()),
            batching: Some(BatchingConfig::default()),
            cost: Some(CostConfig::default()),
            ..Default::default()
        };

        let json = serde_json::to_string_pretty(&original).unwrap();
        let deserialized: NotificationConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(
            get_type_mode(&deserialized, "quality_gates"),
            Some(NotificationMode::NoDuck)
        );
        assert!(deserialized.suppression.is_some());
        assert!(deserialized.batching.is_some());
        assert!(deserialized.cost.is_some());
    }

    #[test]
    fn test_watch_config_defaults() {
        let config = WatchConfig::default();

        assert!(!config.enabled);
        assert_eq!(config.environment, "sandbox");
        assert!(config.apns_key_path.is_none());
        assert!(config.routing.is_empty());
    }

    #[test]
    fn test_should_route_to_watch_disabled() {
        let config = NotificationConfig::default();

        assert!(!should_route_to_watch(&config, "error_alerts"));
        assert!(!should_route_to_watch(&config, "deployments"));
        assert!(!should_route_to_watch(&config, "quality_gates"));
    }

    #[test]
    fn test_should_route_to_watch_default_routing() {
        let watch = WatchConfig {
            enabled: true,
            ..Default::default()
        };

        let config = NotificationConfig {
            watch: Some(watch),
            ..Default::default()
        };

        assert!(should_route_to_watch(&config, "error_alerts"));
        assert!(should_route_to_watch(&config, "deployments"));
        assert!(!should_route_to_watch(&config, "quality_gates"));
    }

    #[test]
    fn test_should_route_to_watch_custom_routing() {
        let mut routing = HashMap::new();
        routing.insert("quality_gates".to_string(), true);
        routing.insert("error_alerts".to_string(), false);

        let watch = WatchConfig {
            enabled: true,
            routing,
            ..Default::default()
        };

        let config = NotificationConfig {
            watch: Some(watch),
            ..Default::default()
        };

        assert!(should_route_to_watch(&config, "quality_gates"));
        assert!(!should_route_to_watch(&config, "error_alerts"));
        assert!(should_route_to_watch(&config, "deployments")); // default
    }

    #[test]
    fn test_deserialize_with_watch_config() {
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            },
            "watch": {
                "enabled": true,
                "apns_key_path": "/path/to/key.p8",
                "apns_key_id": "ABCD123456",
                "apns_team_id": "TEAM123456",
                "bundle_id": "com.example.watchapp",
                "environment": "production",
                "routing": {
                    "error_alerts": true,
                    "deployments": true,
                    "quality_gates": false
                }
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.watch.is_some());

        let watch = config.watch.as_ref().unwrap();
        assert!(watch.enabled);
        assert_eq!(watch.apns_key_path, Some("/path/to/key.p8".to_string()));
        assert_eq!(watch.apns_key_id, Some("ABCD123456".to_string()));
        assert_eq!(watch.apns_team_id, Some("TEAM123456".to_string()));
        assert_eq!(watch.bundle_id, Some("com.example.watchapp".to_string()));
        assert_eq!(watch.environment, "production");
        assert_eq!(watch.routing.len(), 3);
    }

    #[test]
    fn test_watch_config_backward_compatibility() {
        // Old config without watch field should deserialize fine
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.watch.is_none());
        assert!(!should_route_to_watch(&config, "error_alerts"));
    }

    #[test]
    fn test_last_audio_play_serde() {
        let play = LastAudioPlay {
            timestamp: DateTime::parse_from_rfc3339("2026-02-12T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            provider: "elevenlabs".to_string(),
        };

        let json = serde_json::to_string(&play).unwrap();
        let parsed: LastAudioPlay = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.timestamp, play.timestamp);
        assert_eq!(parsed.provider, "elevenlabs");
    }

    #[test]
    fn test_last_audio_play_providers() {
        let providers = ["elevenlabs", "espeak-ng", "espeak", "say"];

        for provider in &providers {
            let play = LastAudioPlay {
                timestamp: Utc::now(),
                provider: provider.to_string(),
            };

            let json = serde_json::to_string(&play).unwrap();
            assert!(json.contains(provider));
        }
    }

    #[test]
    fn test_last_audio_play_path_expansion() {
        let path = last_audio_play_path();
        let path_str = path.to_string_lossy();

        // Should not contain tilde (should be expanded)
        assert!(!path_str.contains('~'));

        // Should end with the expected file name
        assert!(path_str.ends_with("last-audio-play.json"));

        // Should contain the state directory
        assert!(path_str.contains(".claude/scripts/state"));
    }

    #[test]
    fn test_get_last_successful_play_missing_file() {
        // When file doesn't exist, should return None
        // Note: This test assumes the actual state file doesn't exist at test time,
        // or we'd need to use a temp directory and mock the path
        // For now, we just verify the function signature works
        let result = get_last_successful_play();
        // Result could be Some or None depending on system state
        // Just verify it doesn't panic
        drop(result);
    }

    #[test]
    fn test_last_audio_play_json_structure() {
        let play = LastAudioPlay {
            timestamp: DateTime::parse_from_rfc3339("2026-02-12T12:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            provider: "espeak-ng".to_string(),
        };

        let json = serde_json::to_string(&play).unwrap();

        // Verify it contains expected fields
        assert!(json.contains("\"timestamp\""));
        assert!(json.contains("\"provider\""));
        assert!(json.contains("\"espeak-ng\""));
    }

    #[test]
    fn test_tier_config_defaults() {
        let tier_config = TierConfig::default();

        assert_eq!(tier_config.critical, vec!["error_alerts".to_string()]);
        assert_eq!(
            tier_config.high,
            vec!["quality_gates".to_string(), "deployments".to_string()]
        );
        assert_eq!(
            tier_config.normal,
            vec!["reminders".to_string(), "background_tasks".to_string()]
        );
    }

    #[test]
    fn test_get_elevenlabs_threshold_with_configured_tiers() {
        let tier_config = TierConfig {
            critical: vec!["error_alerts".to_string()],
            high: vec!["quality_gates".to_string(), "deployments".to_string()],
            normal: vec!["reminders".to_string()],
        };

        let cost_config = CostConfig {
            track_elevenlabs: true,
            max_daily_elevenlabs: Some(5.0),
            cost_per_100_chars: 0.003,
            tiers: Some(tier_config),
        };

        let config = NotificationConfig {
            cost: Some(cost_config),
            ..Default::default()
        };

        // Critical tier: 100%
        assert_eq!(get_elevenlabs_threshold(&config, "error_alerts"), 1.0);

        // High tier: 90%
        assert_eq!(get_elevenlabs_threshold(&config, "quality_gates"), 0.9);
        assert_eq!(get_elevenlabs_threshold(&config, "deployments"), 0.9);

        // Normal tier: 80%
        assert_eq!(get_elevenlabs_threshold(&config, "reminders"), 0.8);

        // Unknown type defaults to normal: 80%
        assert_eq!(get_elevenlabs_threshold(&config, "unknown_type"), 0.8);
    }

    #[test]
    fn test_get_elevenlabs_threshold_without_tier_config() {
        // No tier config - should use hardcoded defaults
        let config = NotificationConfig::default();

        // Hardcoded critical
        assert_eq!(get_elevenlabs_threshold(&config, "error_alerts"), 1.0);

        // Hardcoded high
        assert_eq!(get_elevenlabs_threshold(&config, "quality_gates"), 0.9);
        assert_eq!(get_elevenlabs_threshold(&config, "deployments"), 0.9);

        // Unknown type defaults to normal
        assert_eq!(get_elevenlabs_threshold(&config, "reminders"), 0.8);
        assert_eq!(get_elevenlabs_threshold(&config, "background_tasks"), 0.8);
    }

    #[test]
    fn test_get_elevenlabs_threshold_with_cost_but_no_tiers() {
        // Cost config exists but tiers is None - should use hardcoded defaults
        let cost_config = CostConfig {
            track_elevenlabs: true,
            max_daily_elevenlabs: Some(5.0),
            cost_per_100_chars: 0.003,
            tiers: None,
        };

        let config = NotificationConfig {
            cost: Some(cost_config),
            ..Default::default()
        };

        assert_eq!(get_elevenlabs_threshold(&config, "error_alerts"), 1.0);
        assert_eq!(get_elevenlabs_threshold(&config, "quality_gates"), 0.9);
        assert_eq!(get_elevenlabs_threshold(&config, "reminders"), 0.8);
    }

    #[test]
    fn test_deserialize_with_tier_config() {
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            },
            "cost": {
                "track_elevenlabs": true,
                "max_daily_elevenlabs": 5.0,
                "cost_per_100_chars": 0.003,
                "tiers": {
                    "critical": ["error_alerts"],
                    "high": ["quality_gates", "deployments"],
                    "normal": ["reminders", "background_tasks"]
                }
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.cost.is_some());

        let cost = config.cost.as_ref().unwrap();
        assert!(cost.tiers.is_some());

        let tiers = cost.tiers.as_ref().unwrap();
        assert_eq!(tiers.critical, vec!["error_alerts".to_string()]);
        assert_eq!(tiers.high.len(), 2);
        assert_eq!(tiers.normal.len(), 2);

        // Test threshold calculation with deserialized config
        assert_eq!(get_elevenlabs_threshold(&config, "error_alerts"), 1.0);
        assert_eq!(get_elevenlabs_threshold(&config, "quality_gates"), 0.9);
    }

    #[test]
    fn test_tier_config_backward_compatibility() {
        // Old cost config without tiers field should deserialize fine
        let json = r#"{
            "server": {
                "host": "0.0.0.0",
                "port": 9999
            },
            "cost": {
                "track_elevenlabs": true,
                "max_daily_elevenlabs": 5.0,
                "cost_per_100_chars": 0.003
            }
        }"#;

        let config: NotificationConfig = serde_json::from_str(json).unwrap();
        assert!(config.cost.is_some());
        assert!(config.cost.as_ref().unwrap().tiers.is_none());

        // Should still work with hardcoded defaults
        assert_eq!(get_elevenlabs_threshold(&config, "error_alerts"), 1.0);
        assert_eq!(get_elevenlabs_threshold(&config, "quality_gates"), 0.9);
    }

    #[test]
    fn test_serialize_with_tiers() {
        let tier_config = TierConfig {
            critical: vec!["error_alerts".to_string()],
            high: vec!["quality_gates".to_string()],
            normal: vec!["reminders".to_string()],
        };

        let cost_config = CostConfig {
            track_elevenlabs: true,
            max_daily_elevenlabs: Some(5.0),
            cost_per_100_chars: 0.003,
            tiers: Some(tier_config),
        };

        let config = NotificationConfig {
            cost: Some(cost_config),
            ..Default::default()
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(json.contains("\"tiers\""));
        assert!(json.contains("\"critical\""));
        assert!(json.contains("\"high\""));
        assert!(json.contains("\"normal\""));
    }

    #[test]
    fn test_serialize_without_tiers() {
        let cost_config = CostConfig {
            track_elevenlabs: true,
            max_daily_elevenlabs: Some(5.0),
            cost_per_100_chars: 0.003,
            tiers: None,
        };

        let config = NotificationConfig {
            cost: Some(cost_config),
            ..Default::default()
        };

        let json = serde_json::to_string_pretty(&config).unwrap();
        // tiers field should be omitted when None (skip_serializing_if)
        assert!(!json.contains("\"tiers\""));
    }
}
