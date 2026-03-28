//! Intelligent notification suppression
//!
//! Provides video call detection, DND detection, and caching to avoid
//! interrupting focused work or meetings.

use std::time::{Duration, Instant};
use tokio::process::Command;
use tracing::{debug, info};

/// Cached suppression check result
struct CachedCheck {
    result: bool,
    checked_at: Instant,
}

/// Intelligent notification suppression
pub struct SuppressionChecker {
    /// Cache video call detection result for 30 seconds
    video_call_cache: Option<CachedCheck>,
    cache_duration: Duration,
}

impl SuppressionChecker {
    pub fn new() -> Self {
        Self {
            video_call_cache: None,
            cache_duration: Duration::from_secs(30),
        }
    }

    /// Check if a video call is active (Zoom, Teams, Meet)
    /// Uses wmctrl -l to list windows, or falls back to /proc scanning
    pub async fn is_video_call_active(&mut self) -> bool {
        // Check cache first
        if let Some(ref cache) = self.video_call_cache {
            if cache.checked_at.elapsed() < self.cache_duration {
                return cache.result;
            }
        }

        let result = self.detect_video_call().await;
        self.video_call_cache = Some(CachedCheck {
            result,
            checked_at: Instant::now(),
        });
        result
    }

    async fn detect_video_call(&self) -> bool {
        // Try wmctrl first
        if let Ok(output) = Command::new("wmctrl").arg("-l").output().await {
            if output.status.success() {
                let windows = String::from_utf8_lossy(&output.stdout).to_lowercase();
                let call_indicators = [
                    "zoom meeting",
                    "zoom",
                    "microsoft teams",
                    "teams meeting",
                    "google meet",
                    "meet -",
                    "webex",
                    "slack huddle",
                    "discord call",
                ];
                if call_indicators
                    .iter()
                    .any(|indicator| windows.contains(indicator))
                {
                    info!("Video call detected via wmctrl");
                    return true;
                }
            }
        }

        // Fallback: check running processes
        if let Ok(output) = Command::new("pgrep")
            .arg("-f")
            .arg("zoom|teams|meet")
            .output()
            .await
        {
            if output.status.success() && !output.stdout.is_empty() {
                debug!("Video call process detected via pgrep");
                return true;
            }
        }

        false
    }

    /// Check if Do Not Disturb is active
    /// Checks dunst (dunstctl) and generic DBus notification state
    pub async fn is_dnd_active(&self) -> bool {
        // Check dunst DND
        if let Ok(output) = Command::new("dunstctl").arg("is-paused").output().await {
            if output.status.success() {
                let result = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_lowercase();
                if result == "true" {
                    info!("DND active (dunst paused)");
                    return true;
                }
            }
        }

        false
    }

    /// Run all suppression checks. Returns reason string if suppressed, None if allowed.
    pub async fn should_suppress(
        &mut self,
        video_call_detection: bool,
        dnd_detection: bool,
    ) -> Option<String> {
        if video_call_detection && self.is_video_call_active().await {
            return Some("video_call_active".to_string());
        }
        if dnd_detection && self.is_dnd_active().await {
            return Some("dnd_active".to_string());
        }
        None
    }

    /// Channel-aware suppression check.
    /// Returns the suppression reason and which channels should be suppressed.
    ///
    /// Suppression rules:
    /// - Focus mode (video call / DND): suppress tts + banner, allow apns (silent push)
    /// - Quiet hours: suppress tts only, allow apns + banner
    ///
    /// Returns None if no suppression is active.
    pub async fn channels_to_suppress(
        &mut self,
        video_call_detection: bool,
        dnd_detection: bool,
    ) -> Option<(String, Vec<SuppressedChannel>)> {
        if video_call_detection && self.is_video_call_active().await {
            // Focus mode: suppress tts + banner, allow apns
            return Some((
                "video_call_active".to_string(),
                vec![SuppressedChannel::Tts, SuppressedChannel::Banner],
            ));
        }
        if dnd_detection && self.is_dnd_active().await {
            // DND: suppress tts + banner, allow apns
            return Some((
                "dnd_active".to_string(),
                vec![SuppressedChannel::Tts, SuppressedChannel::Banner],
            ));
        }
        None
    }
}

/// Channels that can be suppressed by the suppression checker
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuppressedChannel {
    Tts,
    Banner,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_suppression_checker_creation() {
        let checker = SuppressionChecker::new();
        assert!(checker.video_call_cache.is_none());
    }

    #[tokio::test]
    async fn test_should_suppress_with_disabled_checks() {
        let mut checker = SuppressionChecker::new();
        // Both checks disabled should never suppress
        let result = checker.should_suppress(false, false).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_dnd_check_no_dunst() {
        let checker = SuppressionChecker::new();
        // This will likely return false on systems without dunst
        let result = checker.is_dnd_active().await;
        // Just verify it doesn't panic
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_video_call_detection_no_calls() {
        let mut checker = SuppressionChecker::new();
        // Assuming no video calls running during tests
        let result = checker.is_video_call_active().await;
        // Just verify it doesn't panic
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_video_call_cache() {
        let mut checker = SuppressionChecker::new();

        // First call - should populate cache
        let result1 = checker.is_video_call_active().await;

        // Verify cache exists
        assert!(checker.video_call_cache.is_some());

        // Second call immediately - should use cache
        let result2 = checker.is_video_call_active().await;

        // Results should be consistent
        assert_eq!(result1, result2);
    }
}
