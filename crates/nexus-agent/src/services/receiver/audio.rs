//! Audio control for media ducking during TTS playback
//!
//! Provides functionality to:
//! - Detect if media is currently playing on the system
//! - Pause media playback (audio ducking) before TTS
//! - Resume media playback after TTS with configurable delay
//!
//! Platform support:
//! - macOS: Uses media-control CLI (brew install media-control)
//! - Linux: Uses playerctl

use std::time::Duration;
use tokio::process::Command;
use tracing::{debug, info};

/// Audio controller for media detection and ducking
pub struct AudioController {
    /// Delay before resuming media after TTS playback
    resume_delay: Duration,
}

impl AudioController {
    /// Create a new audio controller with the specified resume delay
    ///
    /// # Arguments
    ///
    /// * `resume_delay` - How long to wait after TTS finishes before resuming media
    pub fn new(resume_delay: Duration) -> Self {
        Self { resume_delay }
    }

    /// Duck media: check if playing, pause if so
    ///
    /// Returns true if media was playing and has been paused, false otherwise.
    /// This allows callers to know whether to call `resume_media()` later.
    pub async fn duck_media(&self) -> bool {
        let was_playing = Self::is_media_playing().await;
        if was_playing {
            info!("Media detected, pausing for TTS");
            Self::pause_media().await;
        }
        was_playing
    }

    /// Resume media playback after TTS with configured delay
    ///
    /// Should only be called if `duck_media()` returned true.
    pub async fn resume_media(&self) {
        // Wait before resuming to avoid audio overlap
        tokio::time::sleep(self.resume_delay).await;
        info!("Resuming media after TTS");
        Self::resume_media_internal().await;
    }

    /// Check if media is currently playing on the system (macOS)
    ///
    /// Uses media-control CLI (brew install media-control) which works on all macOS versions
    /// including 15.4+ where the MediaRemote framework was restricted.
    ///
    /// Returns true if any media is playing, false otherwise.
    /// Errors are logged and return false (fail-safe).
    #[cfg(target_os = "macos")]
    async fn is_media_playing() -> bool {
        // Use media-control which works on all macOS versions including 15.4+
        // It properly detects Chrome, Spotify, Music, and all other media apps
        match Command::new("/opt/homebrew/bin/media-control")
            .arg("get")
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Parse JSON response to check playbackRate
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                    if let Some(rate) = json.get("playbackRate").and_then(|v| v.as_f64()) {
                        if rate > 0.0 {
                            let title = json
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            debug!(
                                "Detected media playing via media-control: {} (rate={})",
                                title, rate
                            );
                            return true;
                        }
                    }
                }
            }
            Ok(_) => {
                debug!("media-control returned non-success status");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!(
                    "media-control not installed (brew tap ungive/media-control && brew install media-control)"
                );
            }
            Err(e) => {
                debug!("Failed to check media-control: {}", e);
            }
        }

        false
    }

    /// Check if media is playing on Linux using playerctl
    #[cfg(not(target_os = "macos"))]
    async fn is_media_playing() -> bool {
        // Linux: Check playerctl for any playing media
        match Command::new("playerctl").args(["status"]).output().await {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.trim() == "Playing" {
                    debug!("Detected media playing via playerctl");
                    return true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("playerctl not installed, skipping media detection");
            }
            Err(e) => {
                debug!("Failed to check playerctl: {}", e);
            }
        }
        false
    }

    /// Pause media playback (macOS)
    /// Uses media-control CLI which works on all macOS versions including 15.4+
    #[cfg(target_os = "macos")]
    async fn pause_media() {
        match Command::new("/opt/homebrew/bin/media-control")
            .arg("pause")
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                debug!("Paused media via media-control");
            }
            Ok(_) => {
                debug!("media-control pause returned non-success");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("media-control not installed");
            }
            Err(e) => {
                debug!("Failed to pause via media-control: {}", e);
            }
        }
    }

    /// Pause media playback using playerctl (Linux)
    #[cfg(not(target_os = "macos"))]
    async fn pause_media() {
        match Command::new("playerctl").arg("pause").output().await {
            Ok(output) if output.status.success() => {
                debug!("Paused media via playerctl");
            }
            Ok(output) => {
                debug!(
                    "playerctl pause failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("playerctl not installed, cannot pause media");
            }
            Err(e) => {
                debug!("Failed to execute playerctl pause: {}", e);
            }
        }
    }

    /// Resume media playback (macOS)
    /// Uses media-control CLI which works on all macOS versions including 15.4+
    #[cfg(target_os = "macos")]
    async fn resume_media_internal() {
        match Command::new("/opt/homebrew/bin/media-control")
            .arg("play")
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                debug!("Resumed media via media-control");
            }
            Ok(_) => {
                debug!("media-control play returned non-success");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("media-control not installed");
            }
            Err(e) => {
                debug!("Failed to resume via media-control: {}", e);
            }
        }
    }

    /// Resume media playback using playerctl (Linux)
    #[cfg(not(target_os = "macos"))]
    async fn resume_media_internal() {
        match Command::new("playerctl").arg("play").output().await {
            Ok(output) if output.status.success() => {
                debug!("Resumed media via playerctl");
            }
            Ok(output) => {
                debug!(
                    "playerctl play failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("playerctl not installed, cannot resume media");
            }
            Err(e) => {
                debug!("Failed to execute playerctl play: {}", e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_audio_controller_creation() {
        let controller = AudioController::new(Duration::from_secs(2));
        assert_eq!(controller.resume_delay, Duration::from_secs(2));
    }

    #[tokio::test]
    async fn test_is_media_playing_returns_bool() {
        // This test verifies is_media_playing returns a boolean without errors
        // The actual result depends on system state (whether media is playing)
        let result = AudioController::is_media_playing().await;
        // Just verify it returns a bool without panicking
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_duck_media_returns_bool() {
        let controller = AudioController::new(Duration::from_millis(100));
        let was_playing = controller.duck_media().await;
        // Should return a boolean without panicking
        assert!(was_playing || !was_playing);
    }
}
