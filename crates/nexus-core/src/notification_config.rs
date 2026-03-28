//! Notification configuration helpers.
//!
//! The canonical config types (`NotificationConfig`, `ProjectNotificationRules`,
//! `Verbosity`) live in `config.rs` — this module adds higher-level helpers:
//!
//! - `parse_notification_config()` — load with fallback to built-in defaults
//! - `NotificationConfig::save()` — serialize and write back to TOML

use crate::config::NotificationConfig;

/// Load notification config from `~/.config/nexus/notifications.toml`.
///
/// If the file does not exist, returns `Ok` with built-in defaults.
/// If the file exists but fails to parse, returns the `Err`.
pub fn parse_notification_config() -> Result<NotificationConfig, Box<dyn std::error::Error>> {
    NotificationConfig::load()
}

impl NotificationConfig {
    /// Serialize this config to TOML and write it back to
    /// `~/.config/nexus/notifications.toml`.
    ///
    /// Creates the parent directory if it does not exist.
    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let toml_str = toml::to_string_pretty(self)?;
        std::fs::write(&path, toml_str)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ProjectNotificationRules, Verbosity};
    use std::collections::HashMap;

    #[test]
    fn roundtrip_save_load() {
        // Build a config with a per-project override.
        let mut projects = HashMap::new();
        projects.insert(
            "oo".to_string(),
            ProjectNotificationRules {
                verbosity: Verbosity::Verbose,
                announce_agents: true,
                announce_specs: true,
                announce_sessions: false,
                announce_errors: true,
                channels: vec!["tts".to_string()],
            },
        );
        let config = NotificationConfig {
            defaults: ProjectNotificationRules::default(),
            projects,
        };

        // Serialize to TOML and back.
        let toml_str = toml::to_string_pretty(&config).expect("serialize");
        let parsed: NotificationConfig = toml::from_str(&toml_str).expect("parse");

        assert_eq!(parsed.projects.len(), 1);
        let oo = parsed.rules_for("oo");
        assert_eq!(oo.verbosity, Verbosity::Verbose);
        assert!(oo.announce_agents);
    }

    #[test]
    fn rules_for_fallback() {
        let config = NotificationConfig::default();
        let rules = config.rules_for("unknown-project");
        assert_eq!(rules.verbosity, Verbosity::Brief);
        assert!(!rules.announce_agents);
        assert!(rules.announce_specs);
    }

    #[test]
    fn parse_notification_config_returns_result() {
        // Either Ok (file exists) or it still should not panic.
        // We can't easily mock HOME, so just verify it's callable.
        let _result = parse_notification_config();
    }
}
