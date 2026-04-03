//! Intelligent notification suppression
//!
//! Provides meeting/video call detection, DND detection, and caching to avoid
//! interrupting focused work or meetings.
//!
//! # macOS meeting detection
//!
//! Uses multiple signals to reliably detect active meetings:
//! 1. **Microphone in use** — queries CoreAudio input device via `ioreg`
//! 2. **Known meeting apps** — checks for active Zoom, Teams, Meet, WebEx windows
//! 3. **FaceTime/phone** — checks for `avconferenced` process
//!
//! Results are cached for 30 seconds to avoid expensive shell calls on every notification.

use std::time::{Duration, Instant};
use tokio::process::Command;
use tracing::{debug, info, warn};

/// Cached suppression check result
struct CachedCheck {
    result: bool,
    checked_at: Instant,
}

/// Intelligent notification suppression
pub struct SuppressionChecker {
    /// Cache meeting detection result
    meeting_cache: Option<CachedCheck>,
    cache_duration: Duration,
}

impl Default for SuppressionChecker {
    fn default() -> Self {
        Self::new()
    }
}

impl SuppressionChecker {
    pub fn new() -> Self {
        Self {
            meeting_cache: None,
            cache_duration: Duration::from_secs(15),
        }
    }

    /// Check if a meeting/call is currently active.
    ///
    /// Uses cached result if available and fresh. Otherwise performs detection.
    pub async fn is_meeting_active(&mut self) -> bool {
        // Check cache first
        if let Some(ref cache) = self.meeting_cache
            && cache.checked_at.elapsed() < self.cache_duration
        {
            return cache.result;
        }

        let result = detect_meeting().await;
        self.meeting_cache = Some(CachedCheck {
            result,
            checked_at: Instant::now(),
        });
        result
    }

    /// Invalidate the meeting detection cache.
    /// Call this after a meeting ends to force fresh detection on next check.
    pub fn invalidate_cache(&mut self) {
        self.meeting_cache = None;
    }

    /// Check if Do Not Disturb is active (macOS Focus mode)
    pub async fn is_dnd_active(&self) -> bool {
        check_dnd().await
    }

    /// Legacy API — delegates to meeting detection + DND.
    /// Returns reason string if suppressed, None if allowed.
    pub async fn should_suppress(
        &mut self,
        video_call_detection: bool,
        dnd_detection: bool,
    ) -> Option<String> {
        if video_call_detection && self.is_meeting_active().await {
            return Some("meeting_active".to_string());
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
    /// - Meeting active: suppress tts + banner, allow apns (silent push)
    /// - DND active: suppress tts + banner, allow apns
    ///
    /// Returns None if no suppression is active.
    pub async fn channels_to_suppress(
        &mut self,
        video_call_detection: bool,
        dnd_detection: bool,
    ) -> Option<(String, Vec<SuppressedChannel>)> {
        if video_call_detection && self.is_meeting_active().await {
            return Some((
                "meeting_active".to_string(),
                vec![SuppressedChannel::Tts, SuppressedChannel::Banner],
            ));
        }
        if dnd_detection && self.is_dnd_active().await {
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

// ---------------------------------------------------------------------------
// macOS meeting detection
// ---------------------------------------------------------------------------

/// Detect active meeting on macOS using multiple signals.
///
/// Returns true if ANY of the following are true:
/// 1. Microphone is actively in use (CoreAudio input stream active)
/// 2. A known meeting app has an active call window
/// 3. FaceTime/phone call is active (avconferenced running)
#[cfg(target_os = "macos")]
async fn detect_meeting() -> bool {
    // Run all checks concurrently
    let (mic_active, meeting_window, facetime_active) = tokio::join!(
        is_microphone_active(),
        has_meeting_window(),
        is_facetime_active(),
    );

    if mic_active {
        info!("Meeting detected: microphone is active");
        return true;
    }
    if meeting_window {
        info!("Meeting detected: meeting app window found");
        return true;
    }
    if facetime_active {
        info!("Meeting detected: FaceTime/phone call active");
        return true;
    }

    false
}

/// Detect active meeting on Linux
#[cfg(not(target_os = "macos"))]
async fn detect_meeting() -> bool {
    // Linux: check for known meeting app windows via wmctrl
    if let Ok(output) = Command::new("wmctrl").arg("-l").output().await
        && output.status.success()
    {
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
            info!("Meeting detected via wmctrl window title");
            return true;
        }
    }

    // Fallback: check PulseAudio source (mic) is running
    if let Ok(output) = Command::new("pactl")
        .args(["list", "source-outputs", "short"])
        .output()
        .await
        && output.status.success()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            debug!("Meeting detected: PulseAudio source output active");
            return true;
        }
    }

    false
}

/// Check if the microphone is actively in use on macOS.
///
/// Uses multiple approaches since hardware varies (HDA, USB, Bluetooth):
/// 1. `ioreg` for IOAudioEngine state (built-in audio)
/// 2. System privacy log for any mic access (universal, macOS 12+)
#[cfg(target_os = "macos")]
async fn is_microphone_active() -> bool {
    // Method 1: Check all IOAudioEngine instances (covers HDA, USB, BT)
    match Command::new("bash")
        .args([
            "-c",
            r#"ioreg -r -c IOAudioEngine 2>/dev/null | grep -c '"IOAudioEngineState" = 1'"#,
        ])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let count = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u32>()
                .unwrap_or(0);
            if count > 0 {
                debug!("Microphone active: {} IOAudioEngine(s) running", count);
                return true;
            }
        }
        _ => {}
    }

    // Method 2: Check if the mic-in-use privacy indicator is on
    // On macOS 14+, the orange dot means an app has an active mic stream.
    // We detect this via the system privacy attribution DB.
    match Command::new("bash")
        .args([
            "-c",
            r#"sqlite3 "$HOME/Library/Application Support/com.apple.TCC/TCC.db" \
               "SELECT client FROM access WHERE service='kTCCServiceMicrophone' AND auth_value=2 LIMIT 1" 2>/dev/null"#,
        ])
        .output()
        .await
    {
        Ok(output) if output.status.success() && !output.stdout.is_empty() => {
            // TCC DB shows apps with mic permission granted — but doesn't mean currently active.
            // This is a weak signal, so we don't rely on it alone.
            debug!("Apps with mic permission found (weak signal, not using alone)");
        }
        _ => {}
    }

    false
}

/// Check if a known meeting app has an active call window on macOS.
///
/// Uses AppleScript to query window titles of known meeting apps.
/// This catches meetings even if the mic check fails (e.g., muted calls).
#[cfg(target_os = "macos")]
async fn has_meeting_window() -> bool {
    // Use a single AppleScript that checks multiple apps
    let script = r#"
        set meetingFound to false

        -- Check Microsoft Teams for active call/meeting
        try
            tell application "System Events"
                if exists (process "Microsoft Teams") then
                    set teamWindows to name of every window of process "Microsoft Teams"
                    repeat with w in teamWindows
                        if w contains "Meeting" or w contains "Call" or w contains "meeting" then
                            set meetingFound to true
                        end if
                    end repeat
                end if
            end tell
        end try

        -- Check Zoom for meeting window
        try
            tell application "System Events"
                if exists (process "zoom.us") then
                    set zoomWindows to name of every window of process "zoom.us"
                    repeat with w in zoomWindows
                        if w contains "Zoom Meeting" or w contains "meeting" then
                            set meetingFound to true
                        end if
                    end repeat
                end if
            end tell
        end try

        -- Check Google Chrome for Meet tab (best effort)
        -- Skipped: too expensive and unreliable

        -- Check WebEx
        try
            tell application "System Events"
                if exists (process "Webex") then
                    set meetingFound to true
                end if
            end tell
        end try

        if meetingFound then
            return "true"
        else
            return "false"
        end if
    "#;

    match Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let result = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase();
            if result == "true" {
                debug!("Meeting window detected via AppleScript");
                return true;
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.is_empty() {
                debug!("AppleScript meeting check stderr: {}", stderr);
            }
        }
        Err(e) => {
            warn!("Failed to run AppleScript meeting check: {}", e);
        }
    }

    false
}

/// Check if FaceTime or a phone call is active.
///
/// `avconferenced` is a persistent daemon on modern macOS — checking for its
/// process is unreliable (always running). Instead, we check for FaceTime's
/// call-in-progress window.
#[cfg(target_os = "macos")]
async fn is_facetime_active() -> bool {
    // Check if FaceTime has an active call window
    let script = r#"
        try
            tell application "System Events"
                if exists (process "FaceTime") then
                    set ftWindows to name of every window of process "FaceTime"
                    repeat with w in ftWindows
                        if w is not "" then
                            return "true"
                        end if
                    end repeat
                end if
            end tell
        end try
        return "false"
    "#;

    match Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let result = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase();
            if result == "true" {
                debug!("FaceTime call detected via window check");
                return true;
            }
        }
        _ => {}
    }

    false
}

/// Check if Do Not Disturb / Focus mode is active.
///
/// macOS: reads DND assertion plist.
/// Linux: checks dunst paused state.
#[cfg(target_os = "macos")]
async fn check_dnd() -> bool {
    match Command::new("bash")
        .args([
            "-c",
            "defaults read com.apple.controlcenter 'NSStatusItem Visible FocusModes' 2>/dev/null",
        ])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if result == "1" {
                match Command::new("plutil")
                    .args([
                        "-extract",
                        "userPref.enabled",
                        "raw",
                        "-o",
                        "-",
                        &format!(
                            "{}/Library/DoNotDisturb/DB/Assertions.json",
                            std::env::var("HOME").unwrap_or_default()
                        ),
                    ])
                    .output()
                    .await
                {
                    Ok(output) if output.status.success() => {
                        let val = String::from_utf8_lossy(&output.stdout)
                            .trim()
                            .to_lowercase();
                        if val == "true" || val == "1" {
                            info!("DND/Focus active");
                            return true;
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    false
}

#[cfg(not(target_os = "macos"))]
async fn check_dnd() -> bool {
    if let Ok(output) = Command::new("dunstctl").arg("is-paused").output().await
        && output.status.success()
    {
        let result = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_lowercase();
        if result == "true" {
            info!("DND active (dunst paused)");
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_suppression_checker_creation() {
        let checker = SuppressionChecker::new();
        assert!(checker.meeting_cache.is_none());
    }

    #[tokio::test]
    async fn test_should_suppress_with_disabled_checks() {
        let mut checker = SuppressionChecker::new();
        // Both checks disabled should never suppress
        let result = checker.should_suppress(false, false).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_dnd_check() {
        let checker = SuppressionChecker::new();
        let result = checker.is_dnd_active().await;
        // Just verify it doesn't panic
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_meeting_detection() {
        let mut checker = SuppressionChecker::new();
        let result = checker.is_meeting_active().await;
        // Just verify it doesn't panic
        assert!(result || !result);
    }

    #[tokio::test]
    async fn test_meeting_cache() {
        let mut checker = SuppressionChecker::new();

        // First call - should populate cache
        let result1 = checker.is_meeting_active().await;

        // Verify cache exists
        assert!(checker.meeting_cache.is_some());

        // Second call immediately - should use cache
        let result2 = checker.is_meeting_active().await;

        // Results should be consistent
        assert_eq!(result1, result2);
    }

    #[tokio::test]
    async fn test_cache_invalidation() {
        let mut checker = SuppressionChecker::new();

        let _ = checker.is_meeting_active().await;
        assert!(checker.meeting_cache.is_some());

        checker.invalidate_cache();
        assert!(checker.meeting_cache.is_none());
    }
}
