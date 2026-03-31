//! Public type definitions for the TTS Receiver service.
//!
//! Request/response types, notification records, and channel routing.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Daemon version from Cargo.toml
pub(crate) const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Maximum number of notification records kept in the history ring buffer
pub(crate) const NOTIFICATION_HISTORY_CAPACITY: usize = 20;

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

/// Message type for notification delivery
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum MessageType {
    #[default]
    Brief,
    Extended,
}

/// Delivery channel for notifications
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Tts,
    Apns,
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
    pub fn defaults_for(message_type: MessageType) -> Vec<Channel> {
        match message_type {
            MessageType::Brief => vec![Channel::Tts, Channel::Apns, Channel::Banner],
            MessageType::Extended => vec![Channel::Tts],
        }
    }

    pub fn filter_available(channels: &[Channel]) -> Vec<Channel> {
        channels
            .iter()
            .copied()
            .filter(|ch| match ch {
                Channel::Banner => std::env::consts::OS == "macos",
                Channel::Tts => true,
                Channel::Apns => true,
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/// Request body for POST /speak
#[derive(Debug, Clone, Deserialize)]
pub struct SpeakRequest {
    pub message: String,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default, rename = "type")]
    pub notification_type: Option<String>,
    #[serde(default)]
    pub message_type: MessageType,
    #[serde(default)]
    pub channels: Option<Vec<Channel>>,
}

/// Request body for POST /play
#[derive(Debug, Clone, Deserialize)]
pub struct PlayRequest {
    pub path: String,
    #[serde(default)]
    pub volume: Option<f32>,
}

/// Request body for POST /watch/register
#[derive(Debug, Clone, Deserialize)]
pub struct RegisterWatchRequest {
    pub device_token: String,
    #[serde(default = "default_platform")]
    pub platform: String,
}

fn default_platform() -> String {
    "watchOS".to_string()
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub played: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_resolved: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterWatchResponse {
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioHealth {
    pub output_available: bool,
    pub elevenlabs_key_set: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_tts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_play: Option<String>,
    pub notification_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub uptime_seconds: u64,
    pub port: u16,
    pub buffers: usize,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioHealth>,
}

// ---------------------------------------------------------------------------
// Stored data types
// ---------------------------------------------------------------------------

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

/// A record of a notification received via /speak
#[derive(Debug, Clone, Serialize)]
pub struct NotificationRecord {
    pub message: String,
    pub project: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub notification_type: Option<String>,
}

/// Metadata about the last successfully delivered notification.
#[derive(Debug, Clone, Serialize)]
pub struct LastNotificationInfo {
    pub timestamp: DateTime<Utc>,
    pub message_type: MessageType,
    pub channels_used: Vec<String>,
}
