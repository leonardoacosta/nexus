//! TTS Receiver HTTP service module
//!
//! Provides an HTTP server for receiving TTS notifications from external sources.
//!
//! ## Module Structure
//!
//! - `service` - Main ReceiverService HTTP server implementation
//! - `buffer` - Message buffering and debouncing logic
//! - `dedup` - Message deduplication to prevent duplicate TTS requests
//! - `notification_batch` - Notification batching and coalescing by type
//! - `suppression` - Notification suppression (DND, video calls, etc.)
//! - `audio` - Audio control for media detection and ducking
//! - `tts` - TTS orchestration (tries ElevenLabs, falls back to system TTS)
//! - `tts_system` - System TTS fallback (macOS `say`, Linux `espeak`)
//! - `tts_elevenlabs` - ElevenLabs API integration for TTS generation
//! - `apns` - Apple Push Notification service for Apple Watch delivery
//! - `watch_tokens` - SQLite storage for Apple Watch device tokens

mod apns;
mod audio;
mod banner;
mod buffer;
mod dedup;
mod delivery;
mod http_router;
mod notification_batch;
mod playback_queue;
mod service;
pub mod state;
mod suppression;
mod tts;
mod tts_elevenlabs;
mod tts_system;
pub(crate) mod types;
pub mod watch_tokens;

pub use apns::{ApnsClient, ApnsResponse, ApnsSender, build_apns_payload, build_apns_payload_ext};
pub use audio::AudioController;
pub use banner::BannerDelivery;
pub use buffer::{BufferEntry, MessageBuffer};
pub use dedup::Deduplicator;
pub use notification_batch::{NotificationBatchBuffer, QueuedNotification, is_terminal_focused};
pub use playback_queue::{PlaybackMessage, PlaybackQueue, PlaybackQueueHandle};
pub use service::{
    AudioHealth, Channel, ErrorResponse, HealthResponse, MessageType, PlayRequest, ReceiverService,
    SpeakRequest, StoredMessage, SuccessResponse,
};
pub use suppression::SuppressionChecker;
pub use tts::{TtsOrchestrator, TtsResult, split_into_chunks};
pub use tts_elevenlabs::{ElevenLabsClient, ElevenLabsConfig, ElevenLabsVoiceSettings};
pub use tts_system::SystemTts;
pub use watch_tokens::{WatchDevice, WatchTokenStore};
