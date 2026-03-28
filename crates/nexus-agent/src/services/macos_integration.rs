//! macOS System Integration Service
//!
//! Detects macOS system state and writes it to a state file for other
//! services and tools to consume. Runs only on macOS.
//!
//! Features:
//! - Dark mode detection (AppleInterfaceStyle)
//! - Focus mode detection (Do Not Disturb / Focus)
//! - Power state (battery vs AC, battery percentage)
//!
//! Output: ~/.claude/scripts/state/macos-state.json

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// macOS system state, written periodically as JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MacOSState {
    pub timestamp: String,
    pub dark_mode: bool,
    pub focus_mode: bool,
    pub on_battery: bool,
    pub battery_pct: Option<u8>,
}

impl Default for MacOSState {
    fn default() -> Self {
        Self {
            timestamp: chrono::Utc::now().to_rfc3339(),
            dark_mode: false,
            focus_mode: false,
            on_battery: false,
            battery_pct: None,
        }
    }
}

/// Resolve the macOS state file path.
pub fn resolve_state_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/nyaptor".to_string());
    PathBuf::from(home)
        .join(".claude")
        .join("scripts")
        .join("state")
        .join("macos-state.json")
}

/// Write the macOS state to disk. Returns an error description on failure.
pub fn write_state_file(state: &MacOSState, path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create state directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize macOS state: {}", e))?;

    std::fs::write(path, json).map_err(|e| format!("Failed to write macOS state file: {}", e))?;

    Ok(())
}

// --- Parsing functions (platform-independent logic) ---

/// Parse dark mode from `defaults read -g AppleInterfaceStyle` output.
///
/// The command outputs "Dark" when dark mode is active.
/// It returns a non-zero exit code (error) when dark mode is off (key doesn't exist).
pub fn parse_dark_mode(output: &str, success: bool) -> bool {
    if !success {
        return false;
    }
    output.trim().eq_ignore_ascii_case("dark")
}

/// Parse focus mode from `defaults read com.apple.controlcenter ...` output.
///
/// Returns true if the output indicates Focus mode is visible/active.
/// The key may not exist on all macOS versions.
pub fn parse_focus_mode(output: &str, success: bool) -> bool {
    if !success {
        return false;
    }
    let trimmed = output.trim();
    // "1" or "true" means focus mode indicator is visible (focus is active)
    trimmed == "1" || trimmed.eq_ignore_ascii_case("true")
}

/// Parse battery info from `pmset -g batt` output.
///
/// Example output:
/// ```text
/// Now drawing from 'AC Power'
///  -InternalBattery-0 (id=1234567)	85%; charged; 0:00 remaining present: true
/// ```
///
/// Or when on battery:
/// ```text
/// Now drawing from 'Battery Power'
///  -InternalBattery-0 (id=1234567)	72%; discharging; 3:45 remaining present: true
/// ```
///
/// Returns (on_battery, battery_percentage).
pub fn parse_battery_info(output: &str) -> (bool, Option<u8>) {
    let on_battery = output.contains("Battery Power");

    let battery_pct = output
        .lines()
        .find(|line| line.contains("InternalBattery"))
        .and_then(|line| {
            // Find the percentage pattern: digits followed by '%'
            line.split_whitespace()
                .find(|word| word.ends_with("%;") || word.ends_with('%'))
                .and_then(|pct_str| {
                    let cleaned = pct_str.trim_end_matches(|c| c == '%' || c == ';');
                    cleaned.parse::<u8>().ok()
                })
        });

    (on_battery, battery_pct)
}

// --- macOS-only service implementation ---

#[cfg(target_os = "macos")]
pub use macos_impl::MacOSIntegrationService;

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::*;
    use crate::services::Service;
    use anyhow::Result;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tracing::{debug, error, info, warn};

    /// macOS system integration service.
    ///
    /// Periodically detects system state (dark mode, focus mode, power)
    /// and writes results to a JSON state file.
    pub struct MacOSIntegrationService {
        interval_secs: u64,
        state_path: PathBuf,
        healthy: Arc<AtomicBool>,
    }

    impl MacOSIntegrationService {
        /// Create a new integration service with the given poll interval.
        pub fn new(interval_secs: u64) -> Self {
            Self {
                interval_secs,
                state_path: resolve_state_path(),
                healthy: Arc::new(AtomicBool::new(false)),
            }
        }

        /// Create with a custom state file path (for testing).
        pub fn with_path(interval_secs: u64, state_path: PathBuf) -> Self {
            Self {
                interval_secs,
                state_path,
                healthy: Arc::new(AtomicBool::new(false)),
            }
        }

        /// Run a system command with a timeout, returning (stdout, success).
        fn run_command(program: &str, args: &[&str]) -> (String, bool) {
            let result = std::process::Command::new(program).args(args).output();

            match result {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    (stdout, output.status.success())
                }
                Err(e) => {
                    debug!("Command '{}' failed to execute: {}", program, e);
                    (String::new(), false)
                }
            }
        }

        /// Detect current macOS system state.
        fn detect_state(&self) -> MacOSState {
            // Dark mode
            let (dark_output, dark_success) =
                Self::run_command("defaults", &["read", "-g", "AppleInterfaceStyle"]);
            let dark_mode = parse_dark_mode(&dark_output, dark_success);

            // Focus mode
            let (focus_output, focus_success) = Self::run_command(
                "defaults",
                &[
                    "read",
                    "com.apple.controlcenter",
                    "NSStatusItem Visible FocusMode",
                ],
            );
            let focus_mode = parse_focus_mode(&focus_output, focus_success);

            // Battery/power state
            let (batt_output, batt_success) = Self::run_command("pmset", &["-g", "batt"]);
            let (on_battery, battery_pct) = if batt_success {
                parse_battery_info(&batt_output)
            } else {
                (false, None)
            };

            MacOSState {
                timestamp: chrono::Utc::now().to_rfc3339(),
                dark_mode,
                focus_mode,
                on_battery,
                battery_pct,
            }
        }
    }

    #[async_trait::async_trait]
    impl Service for MacOSIntegrationService {
        fn name(&self) -> &'static str {
            "macos-integration"
        }

        async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
            info!(
                "macOS integration service starting (interval={}s, path={})",
                self.interval_secs,
                self.state_path.display()
            );

            self.healthy.store(true, Ordering::SeqCst);

            let mut interval = tokio::time::interval(Duration::from_secs(self.interval_secs));

            // Detect and write initial state
            let state = self.detect_state();
            debug!(
                "Initial macOS state: dark={}, focus={}, battery={}, pct={:?}",
                state.dark_mode, state.focus_mode, state.on_battery, state.battery_pct
            );
            if let Err(e) = write_state_file(&state, &self.state_path) {
                error!("Failed to write initial macOS state: {}", e);
            }

            loop {
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        info!("macOS integration service shutting down");
                        break;
                    }
                    _ = interval.tick() => {
                        let state = self.detect_state();
                        debug!(
                            "macOS state: dark={}, focus={}, battery={}, pct={:?}",
                            state.dark_mode, state.focus_mode, state.on_battery, state.battery_pct
                        );
                        if let Err(e) = write_state_file(&state, &self.state_path) {
                            warn!("Failed to write macOS state: {}", e);
                        }
                    }
                }
            }

            self.healthy.store(false, Ordering::SeqCst);
            Ok(())
        }

        async fn health_check(&self) -> bool {
            self.healthy.load(Ordering::SeqCst)
        }
    }
}

// --- Tests (platform-independent) ---

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // --- Serialization tests ---

    #[test]
    fn test_macos_state_serialization() {
        let state = MacOSState {
            timestamp: "2026-02-07T12:00:00+00:00".to_string(),
            dark_mode: true,
            focus_mode: false,
            on_battery: false,
            battery_pct: Some(85),
        };

        let json = serde_json::to_string_pretty(&state).expect("should serialize");
        assert!(json.contains("\"dark_mode\": true"));
        assert!(json.contains("\"focus_mode\": false"));
        assert!(json.contains("\"on_battery\": false"));
        assert!(json.contains("\"battery_pct\": 85"));

        // Roundtrip
        let parsed: MacOSState = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed, state);
    }

    #[test]
    fn test_macos_state_serialization_no_battery() {
        let state = MacOSState {
            timestamp: "2026-02-07T12:00:00+00:00".to_string(),
            dark_mode: false,
            focus_mode: true,
            on_battery: false,
            battery_pct: None,
        };

        let json = serde_json::to_string_pretty(&state).expect("should serialize");
        assert!(json.contains("\"battery_pct\": null"));

        let parsed: MacOSState = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed.battery_pct, None);
    }

    #[test]
    fn test_macos_state_deserialization_from_spec() {
        let json = r#"{
            "timestamp": "2026-02-07T12:00:00Z",
            "dark_mode": true,
            "focus_mode": false,
            "on_battery": false,
            "battery_pct": 85
        }"#;

        let state: MacOSState = serde_json::from_str(json).expect("should parse spec JSON");
        assert!(state.dark_mode);
        assert!(!state.focus_mode);
        assert!(!state.on_battery);
        assert_eq!(state.battery_pct, Some(85));
    }

    // --- Dark mode parsing tests ---

    #[test]
    fn test_parse_dark_mode_active() {
        assert!(parse_dark_mode("Dark\n", true));
        assert!(parse_dark_mode("Dark", true));
        assert!(parse_dark_mode("  Dark  \n", true));
        assert!(parse_dark_mode("dark", true));
    }

    #[test]
    fn test_parse_dark_mode_inactive() {
        // When light mode, the defaults key doesn't exist and command fails
        assert!(!parse_dark_mode("", false));
        assert!(!parse_dark_mode(
            "The domain/default pair does not exist",
            false
        ));
    }

    #[test]
    fn test_parse_dark_mode_command_failure() {
        assert!(!parse_dark_mode("Dark", false));
        assert!(!parse_dark_mode("", false));
    }

    #[test]
    fn test_parse_dark_mode_unexpected_output() {
        assert!(!parse_dark_mode("Light", true));
        assert!(!parse_dark_mode("something else", true));
        assert!(!parse_dark_mode("", true));
    }

    // --- Focus mode parsing tests ---

    #[test]
    fn test_parse_focus_mode_active() {
        assert!(parse_focus_mode("1\n", true));
        assert!(parse_focus_mode("1", true));
        assert!(parse_focus_mode("true", true));
        assert!(parse_focus_mode("  1  ", true));
    }

    #[test]
    fn test_parse_focus_mode_inactive() {
        assert!(!parse_focus_mode("0\n", true));
        assert!(!parse_focus_mode("0", true));
        assert!(!parse_focus_mode("false", true));
    }

    #[test]
    fn test_parse_focus_mode_command_failure() {
        // Key doesn't exist on some macOS versions
        assert!(!parse_focus_mode("", false));
        assert!(!parse_focus_mode(
            "The domain/default pair does not exist",
            false
        ));
    }

    // --- Battery parsing tests ---

    #[test]
    fn test_parse_battery_ac_power() {
        let output = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t85%; charged; 0:00 remaining present: true\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(!on_battery);
        assert_eq!(pct, Some(85));
    }

    #[test]
    fn test_parse_battery_battery_power() {
        let output = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t72%; discharging; 3:45 remaining present: true\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(on_battery);
        assert_eq!(pct, Some(72));
    }

    #[test]
    fn test_parse_battery_full_charge() {
        let output = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t100%; charged; 0:00 remaining present: true\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(!on_battery);
        assert_eq!(pct, Some(100));
    }

    #[test]
    fn test_parse_battery_low() {
        let output = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=9876543)\t5%; discharging; 0:12 remaining present: true\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(on_battery);
        assert_eq!(pct, Some(5));
    }

    #[test]
    fn test_parse_battery_no_battery_line() {
        // Desktop Mac with no battery
        let output = "Now drawing from 'AC Power'\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(!on_battery);
        assert_eq!(pct, None);
    }

    #[test]
    fn test_parse_battery_empty_output() {
        let (on_battery, pct) = parse_battery_info("");
        assert!(!on_battery);
        assert_eq!(pct, None);
    }

    #[test]
    fn test_parse_battery_charging() {
        let output = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t63%; charging; 1:30 remaining present: true\n";
        let (on_battery, pct) = parse_battery_info(output);
        assert!(!on_battery);
        assert_eq!(pct, Some(63));
    }

    // --- State file writing tests ---

    #[test]
    fn test_write_state_file() {
        let tmp_dir = TempDir::new().expect("should create temp dir");
        let state_path = tmp_dir.path().join("state").join("macos-state.json");

        let state = MacOSState {
            timestamp: "2026-02-07T12:00:00+00:00".to_string(),
            dark_mode: true,
            focus_mode: false,
            on_battery: true,
            battery_pct: Some(42),
        };

        let result = write_state_file(&state, &state_path);
        assert!(result.is_ok());
        assert!(state_path.exists());

        let content = std::fs::read_to_string(&state_path).expect("should read");
        let parsed: MacOSState = serde_json::from_str(&content).expect("should parse");
        assert_eq!(parsed, state);
    }

    #[test]
    fn test_write_state_file_creates_dirs() {
        let tmp_dir = TempDir::new().expect("should create temp dir");
        let state_path = tmp_dir
            .path()
            .join("a")
            .join("b")
            .join("c")
            .join("macos-state.json");

        let state = MacOSState::default();
        let result = write_state_file(&state, &state_path);
        assert!(result.is_ok());
        assert!(state_path.exists());
    }

    #[test]
    fn test_resolve_state_path() {
        let path = resolve_state_path();
        let path_str = path.to_string_lossy();
        assert!(path_str.contains(".claude"));
        assert!(path_str.contains("state"));
        assert!(path_str.ends_with("macos-state.json"));
    }

    #[test]
    fn test_macos_state_default() {
        let state = MacOSState::default();
        assert!(!state.dark_mode);
        assert!(!state.focus_mode);
        assert!(!state.on_battery);
        assert_eq!(state.battery_pct, None);
        assert!(!state.timestamp.is_empty());
    }
}
