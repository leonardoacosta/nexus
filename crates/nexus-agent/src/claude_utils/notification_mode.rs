//! Notification mode state management for Claude scripts.
//!
//! Manages atomic read/write of notification mode state with four modes:
//! - Full: ElevenLabs TTS + ducking + desktop notification
//! - System: System TTS only (espeak/say), no ElevenLabs API
//! - NoDuck: TTS plays but media is NOT paused/resumed
//! - Silent: Log only, no audio at all

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::path::expand_home;

/// Default state file path
const DEFAULT_STATE_FILE: &str = "~/.claude/scripts/state/notification-mode.json";

/// Notification mode levels
///
/// Ordered from loudest to quietest: Full > NoDuck > System > Silent
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationMode {
    /// Full audio: ElevenLabs + ducking + desktop notification
    Full,
    /// System TTS only (espeak/say), no ElevenLabs API call
    System,
    /// TTS plays but media is NOT paused/resumed
    NoDuck,
    /// Log only, no audio at all
    Silent,
}

impl PartialOrd for NotificationMode {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for NotificationMode {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.to_numeric().cmp(&other.to_numeric())
    }
}

impl NotificationMode {
    /// Get the next mode in the cycle
    fn next(&self) -> Self {
        match self {
            Self::Full => Self::System,
            Self::System => Self::NoDuck,
            Self::NoDuck => Self::Silent,
            Self::Silent => Self::Full,
        }
    }

    /// Convert mode to numeric value for ordering
    ///
    /// Full=3, NoDuck=2, System=1, Silent=0
    /// Higher values are "louder" modes
    pub fn to_numeric(&self) -> u8 {
        match self {
            Self::Full => 3,
            Self::NoDuck => 2,
            Self::System => 1,
            Self::Silent => 0,
        }
    }

    /// Check if this mode is stricter (quieter) than another
    ///
    /// Returns true if `self` is quieter than `other`.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// # use nexus_agent::claude_utils::notification_mode::NotificationMode;
    ///
    /// assert!(NotificationMode::Silent.is_stricter_than(&NotificationMode::Full));
    /// assert!(!NotificationMode::Full.is_stricter_than(&NotificationMode::Silent));
    /// assert!(!NotificationMode::System.is_stricter_than(&NotificationMode::System));
    /// ```
    pub fn is_stricter_than(&self, other: &Self) -> bool {
        self < other
    }

    /// Return the strictest (quietest) of two modes
    ///
    /// Implements the "quietest wins" rule.
    ///
    /// # Examples
    ///
    /// ```ignore
    /// # use nexus_agent::claude_utils::notification_mode::NotificationMode;
    ///
    /// assert_eq!(NotificationMode::Full.strictest(NotificationMode::Silent), NotificationMode::Silent);
    /// assert_eq!(NotificationMode::System.strictest(NotificationMode::NoDuck), NotificationMode::System);
    /// assert_eq!(NotificationMode::Silent.strictest(NotificationMode::Silent), NotificationMode::Silent);
    /// ```
    pub fn strictest(self, other: Self) -> Self {
        if self < other {
            self
        } else {
            other
        }
    }
}

impl std::fmt::Display for NotificationMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full => write!(f, "full"),
            Self::System => write!(f, "system"),
            Self::NoDuck => write!(f, "noduck"),
            Self::Silent => write!(f, "silent"),
        }
    }
}

impl std::str::FromStr for NotificationMode {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.to_lowercase().as_str() {
            "full" => Ok(Self::Full),
            "system" => Ok(Self::System),
            "noduck" => Ok(Self::NoDuck),
            "silent" => Ok(Self::Silent),
            _ => Err(anyhow::anyhow!(
                "Invalid notification mode: '{}'. Valid modes: full, system, noduck, silent",
                s
            )),
        }
    }
}

/// Notification mode state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationModeState {
    /// Current notification mode
    pub mode: NotificationMode,
    /// Timestamp when the mode was last updated
    pub updated_at: DateTime<Utc>,
    /// Source of the update (cli, statusline, skill, etc.)
    pub updated_by: String,
}

impl Default for NotificationModeState {
    fn default() -> Self {
        Self {
            mode: NotificationMode::Full,
            updated_at: Utc::now(),
            updated_by: "default".to_string(),
        }
    }
}

/// Get the notification mode state file path
///
/// Returns `~/.claude/scripts/state/notification-mode.json`
///
/// # Examples
///
/// ```ignore
/// use claude_utils::notification_mode::notification_mode_state_path;
///
/// let path = notification_mode_state_path();
/// assert!(path.to_string_lossy().ends_with("notification-mode.json"));
/// ```
pub fn notification_mode_state_path() -> PathBuf {
    expand_home(DEFAULT_STATE_FILE)
}

/// Read notification mode from state file
///
/// Returns `Full` mode if file is missing or cannot be parsed.
///
/// # Examples
///
/// ```ignore
/// use claude_utils::notification_mode::{get_notification_mode, NotificationMode};
///
/// let mode = get_notification_mode();
/// assert!(matches!(mode, NotificationMode::Full | NotificationMode::System | NotificationMode::NoDuck | NotificationMode::Silent));
/// ```
pub fn get_notification_mode() -> NotificationMode {
    let path = notification_mode_state_path();

    match fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str::<NotificationModeState>(&contents) {
            Ok(state) => {
                super::log::log(
                    "DEBUG",
                    &format!("Read notification mode: {:?}", state.mode),
                );
                state.mode
            }
            Err(e) => {
                super::log::log(
                    "WARN",
                    &format!(
                        "Failed to parse notification mode state: {}, using default",
                        e
                    ),
                );
                NotificationMode::Full
            }
        },
        Err(_) => {
            // File doesn't exist or can't be read, use default
            NotificationMode::Full
        }
    }
}

/// Set notification mode and write to state file atomically
///
/// Uses atomic write pattern (write to temp file, then rename) to ensure consistency.
///
/// # Arguments
///
/// * `mode` - The notification mode to set
/// * `source` - Source of the update (e.g., "cli", "statusline", "skill")
///
/// # Examples
///
/// ```ignore
/// use claude_utils::notification_mode::{set_notification_mode, NotificationMode};
///
/// set_notification_mode(NotificationMode::System, "cli").unwrap();
/// ```
pub fn set_notification_mode(mode: NotificationMode, source: &str) -> Result<()> {
    let path = notification_mode_state_path();

    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Failed to create state directory")?;
    }

    let state = NotificationModeState {
        mode,
        updated_at: Utc::now(),
        updated_by: source.to_string(),
    };

    // Serialize to JSON
    let json = serde_json::to_string_pretty(&state)
        .context("Failed to serialize notification mode state")?;

    // Atomic write: write to temp file, then rename
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).context("Failed to write temporary state file")?;

    fs::rename(&temp_path, &path).context("Failed to atomically replace state file")?;

    super::log::log(
        "INFO",
        &format!("Set notification mode to {:?} (source: {})", mode, source),
    );

    Ok(())
}

/// Cycle to the next notification mode
///
/// Reads current mode, advances to next in cycle (Full→System→NoDuck→Silent→Full),
/// writes new state, and returns the new mode.
///
/// # Examples
///
/// ```ignore
/// use claude_utils::notification_mode::cycle_notification_mode;
///
/// let new_mode = cycle_notification_mode().unwrap();
/// println!("Cycled to mode: {:?}", new_mode);
/// ```
pub fn cycle_notification_mode() -> Result<NotificationMode> {
    let current = get_notification_mode();
    let next = current.next();
    set_notification_mode(next, "cycle")?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_notification_mode_serde() {
        // Test serialization of each mode
        let modes = [
            NotificationMode::Full,
            NotificationMode::System,
            NotificationMode::NoDuck,
            NotificationMode::Silent,
        ];

        for mode in &modes {
            let json = serde_json::to_string(mode).unwrap();
            let parsed: NotificationMode = serde_json::from_str(&json).unwrap();
            assert_eq!(*mode, parsed);
        }
    }

    #[test]
    fn test_mode_names() {
        // Test that modes serialize to expected lowercase names
        assert_eq!(
            serde_json::to_string(&NotificationMode::Full).unwrap(),
            "\"full\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationMode::System).unwrap(),
            "\"system\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationMode::NoDuck).unwrap(),
            "\"noduck\""
        );
        assert_eq!(
            serde_json::to_string(&NotificationMode::Silent).unwrap(),
            "\"silent\""
        );
    }

    #[test]
    fn test_cycle_order() {
        // Test the cycle order: Full→System→NoDuck→Silent→Full
        assert_eq!(NotificationMode::Full.next(), NotificationMode::System);
        assert_eq!(NotificationMode::System.next(), NotificationMode::NoDuck);
        assert_eq!(NotificationMode::NoDuck.next(), NotificationMode::Silent);
        assert_eq!(NotificationMode::Silent.next(), NotificationMode::Full);
    }

    #[test]
    fn test_state_path_expansion() {
        let path = notification_mode_state_path();
        let path_str = path.to_string_lossy();

        // Should not contain tilde (should be expanded)
        assert!(!path_str.contains('~'));

        // Should end with the expected file name
        assert!(path_str.ends_with("notification-mode.json"));

        // Should contain the state directory
        assert!(path_str.contains(".claude/scripts/state"));
    }

    #[test]
    fn test_set_and_get_roundtrip() {
        let temp_dir = TempDir::new().unwrap();
        let state_path = temp_dir.path().join("notification-mode.json");

        // Override the state path for testing by using the temp path directly
        // Note: In real usage, the path is fixed. This test uses temp_dir for isolation.

        // Write state manually
        let state = NotificationModeState {
            mode: NotificationMode::System,
            updated_at: Utc::now(),
            updated_by: "test".to_string(),
        };

        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        let json = serde_json::to_string_pretty(&state).unwrap();
        fs::write(&state_path, json).unwrap();

        // Read back
        let contents = fs::read_to_string(&state_path).unwrap();
        let parsed: NotificationModeState = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed.mode, NotificationMode::System);
        assert_eq!(parsed.updated_by, "test");
    }

    #[test]
    fn test_atomic_write() {
        let temp_dir = TempDir::new().unwrap();
        let state_path = temp_dir.path().join("notification-mode.json");

        // Create initial state
        let state = NotificationModeState {
            mode: NotificationMode::Full,
            updated_at: Utc::now(),
            updated_by: "initial".to_string(),
        };

        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        let json = serde_json::to_string_pretty(&state).unwrap();
        fs::write(&state_path, json).unwrap();

        // Simulate atomic write
        let new_state = NotificationModeState {
            mode: NotificationMode::Silent,
            updated_at: Utc::now(),
            updated_by: "updated".to_string(),
        };

        let temp_path = state_path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&new_state).unwrap();
        fs::write(&temp_path, json).unwrap();
        fs::rename(&temp_path, &state_path).unwrap();

        // Verify new state
        let contents = fs::read_to_string(&state_path).unwrap();
        let parsed: NotificationModeState = serde_json::from_str(&contents).unwrap();
        assert_eq!(parsed.mode, NotificationMode::Silent);
        assert_eq!(parsed.updated_by, "updated");

        // Temp file should not exist after rename
        assert!(!temp_path.exists());
    }

    #[test]
    fn test_default_state() {
        let state = NotificationModeState::default();
        assert_eq!(state.mode, NotificationMode::Full);
        assert_eq!(state.updated_by, "default");
    }

    #[test]
    fn test_state_json_structure() {
        let state = NotificationModeState {
            mode: NotificationMode::System,
            updated_at: DateTime::parse_from_rfc3339("2026-02-09T21:40:00Z")
                .unwrap()
                .with_timezone(&Utc),
            updated_by: "cli".to_string(),
        };

        let json = serde_json::to_string(&state).unwrap();

        // Verify it contains expected fields
        assert!(json.contains("\"mode\""));
        assert!(json.contains("\"system\""));
        assert!(json.contains("\"updated_at\""));
        assert!(json.contains("\"updated_by\""));
        assert!(json.contains("\"cli\""));
    }

    #[test]
    fn test_to_numeric() {
        assert_eq!(NotificationMode::Full.to_numeric(), 3);
        assert_eq!(NotificationMode::NoDuck.to_numeric(), 2);
        assert_eq!(NotificationMode::System.to_numeric(), 1);
        assert_eq!(NotificationMode::Silent.to_numeric(), 0);
    }

    #[test]
    fn test_ordering() {
        // Silent < System < NoDuck < Full
        assert!(NotificationMode::Silent < NotificationMode::System);
        assert!(NotificationMode::System < NotificationMode::NoDuck);
        assert!(NotificationMode::NoDuck < NotificationMode::Full);

        // Transitive
        assert!(NotificationMode::Silent < NotificationMode::Full);

        // Equality
        assert!(NotificationMode::Full == NotificationMode::Full);
        assert!(!(NotificationMode::Full < NotificationMode::Full));
    }

    #[test]
    fn test_is_stricter_than() {
        // Silent is stricter than everything
        assert!(NotificationMode::Silent.is_stricter_than(&NotificationMode::System));
        assert!(NotificationMode::Silent.is_stricter_than(&NotificationMode::NoDuck));
        assert!(NotificationMode::Silent.is_stricter_than(&NotificationMode::Full));

        // Full is not stricter than anything
        assert!(!NotificationMode::Full.is_stricter_than(&NotificationMode::NoDuck));
        assert!(!NotificationMode::Full.is_stricter_than(&NotificationMode::System));
        assert!(!NotificationMode::Full.is_stricter_than(&NotificationMode::Silent));

        // System is stricter than NoDuck and Full
        assert!(NotificationMode::System.is_stricter_than(&NotificationMode::NoDuck));
        assert!(NotificationMode::System.is_stricter_than(&NotificationMode::Full));
        assert!(!NotificationMode::System.is_stricter_than(&NotificationMode::Silent));

        // Equal modes are not stricter than each other
        assert!(!NotificationMode::System.is_stricter_than(&NotificationMode::System));
    }

    #[test]
    fn test_strictest() {
        // Silent wins against everything
        assert_eq!(
            NotificationMode::Full.strictest(NotificationMode::Silent),
            NotificationMode::Silent
        );
        assert_eq!(
            NotificationMode::Silent.strictest(NotificationMode::Full),
            NotificationMode::Silent
        );

        // System wins against NoDuck and Full
        assert_eq!(
            NotificationMode::System.strictest(NotificationMode::NoDuck),
            NotificationMode::System
        );
        assert_eq!(
            NotificationMode::Full.strictest(NotificationMode::System),
            NotificationMode::System
        );

        // NoDuck wins against Full
        assert_eq!(
            NotificationMode::Full.strictest(NotificationMode::NoDuck),
            NotificationMode::NoDuck
        );

        // Equal modes return the same mode
        assert_eq!(
            NotificationMode::Silent.strictest(NotificationMode::Silent),
            NotificationMode::Silent
        );
        assert_eq!(
            NotificationMode::Full.strictest(NotificationMode::Full),
            NotificationMode::Full
        );
    }
}
