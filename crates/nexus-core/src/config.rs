use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::paths::nexus_config_dir;

/// Errors that can occur when loading or saving Nexus configuration files.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config file not found: {0}")]
    NotFound(PathBuf),
    #[error("failed to parse config: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("failed to serialize config: {0}")]
    Serialize(#[from] toml::ser::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// The role this nexus-agent instance plays in the fleet.
///
/// - `Primary`: The Mac — runs ReceiverService (TTS/APNs/banner), NotificationEngine,
///   and EventForwarder. Receives events from all peer agents and delivers audio/push.
/// - `Agent`: A remote machine (e.g. homelab) — runs gRPC, HTTP health, and socket
///   listener only. No audio dependencies, no TTS output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AgentRole {
    /// Primary notification brain — runs all subsystems including ReceiverService.
    #[default]
    Primary,
    /// Remote agent — gRPC + health + socket only, no notification infrastructure.
    Agent,
}

impl std::fmt::Display for AgentRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentRole::Primary => write!(f, "primary"),
            AgentRole::Agent => write!(f, "agent"),
        }
    }
}

/// Nexus configuration, loaded from ~/.config/nexus/agents.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusConfig {
    pub agents: Vec<AgentConfig>,
    /// Role for this machine. Defaults to Primary if absent.
    #[serde(default)]
    pub role: AgentRole,
    /// Name of this agent (must match one entry in `agents`). Defaults to hostname.
    #[serde(default)]
    pub self_name: Option<String>,
    /// Session pool configuration. Omit to use defaults.
    #[serde(default)]
    pub pool: Option<PoolConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Human-readable name (e.g. "homelab", "macbook")
    pub name: String,
    /// Tailscale MagicDNS hostname or IP
    pub host: String,
    /// Nexus agent API port (default: 7400)
    #[serde(default = "default_port")]
    pub port: u16,
    /// SSH user for full attach
    pub user: String,
}

fn default_port() -> u16 {
    7400
}

impl NexusConfig {
    pub fn config_path() -> PathBuf {
        nexus_config_dir().join("agents.toml")
    }

    pub fn load() -> Result<Self, ConfigError> {
        let path = Self::config_path();
        let contents = std::fs::read_to_string(&path)?;
        let config: Self = toml::from_str(&contents)?;
        Ok(config)
    }

    /// Return peers that this agent should subscribe to (all agents except self).
    pub fn peers(&self, self_name: &str) -> Vec<&AgentConfig> {
        self.agents.iter().filter(|a| a.name != self_name).collect()
    }
}

/// Verbosity level for project-specific notification rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Verbosity {
    /// Full detail — agent type, task counts, duration.
    Verbose,
    /// Project name + event type only.
    #[default]
    Brief,
    /// Suppress all notifications for this project.
    Silent,
}

/// Per-project notification rules.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectNotificationRules {
    /// Verbosity level for messages from this project.
    #[serde(default)]
    pub verbosity: Verbosity,
    /// Announce agent spawns/completions.
    #[serde(default)]
    pub announce_agents: bool,
    /// Announce spec completions.
    #[serde(default = "default_true")]
    pub announce_specs: bool,
    /// Announce session start/stop.
    #[serde(default)]
    pub announce_sessions: bool,
    /// Always announce errors regardless of other settings.
    #[serde(default = "default_true")]
    pub announce_errors: bool,
    /// Delivery channels (e.g. ["tts"], ["tts", "apns"]).
    #[serde(default = "default_channels")]
    pub channels: Vec<String>,
}

impl Default for ProjectNotificationRules {
    fn default() -> Self {
        Self {
            verbosity: Verbosity::Brief,
            announce_agents: false,
            announce_specs: true,
            announce_sessions: false,
            announce_errors: true,
            channels: default_channels(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_channels() -> Vec<String> {
    vec!["tts".to_string()]
}

/// Notification configuration loaded from ~/.config/nexus/notifications.toml.
///
/// Controls which events generate TTS messages and at what verbosity.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NotificationConfig {
    /// Default rules applied to projects not listed in `projects`.
    #[serde(default)]
    pub defaults: ProjectNotificationRules,
    /// Per-project overrides keyed by project code (e.g. "oo", "tl").
    #[serde(default)]
    pub projects: HashMap<String, ProjectNotificationRules>,
}

impl NotificationConfig {
    pub fn config_path() -> PathBuf {
        nexus_config_dir().join("notifications.toml")
    }

    /// Load from ~/.config/nexus/notifications.toml.
    /// Returns `Ok(Default::default())` if the file does not exist.
    pub fn load() -> Result<Self, ConfigError> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(&path)?;
        let config: Self = toml::from_str(&contents)?;
        Ok(config)
    }

    /// Return the effective rules for the given project code.
    /// Falls back to `defaults` if no per-project override exists.
    pub fn rules_for(&self, project: &str) -> &ProjectNotificationRules {
        self.projects.get(project).unwrap_or(&self.defaults)
    }
}

/// Configuration for the session pool — warm Claude Code sessions per project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolConfig {
    /// Whether the session pool is enabled.
    #[serde(default = "default_pool_enabled")]
    pub enabled: bool,
    /// Maximum number of pooled sessions across all projects.
    #[serde(default = "default_max_sessions")]
    pub max_sessions: usize,
    /// How long (in minutes) a session can be idle before eviction.
    #[serde(default = "default_idle_timeout_minutes")]
    pub idle_timeout_minutes: u64,
    /// Project codes to pre-warm on agent startup (e.g. ["oo", "nx"]).
    #[serde(default)]
    pub warmup_on_startup: Vec<String>,
}

impl Default for PoolConfig {
    fn default() -> Self {
        Self {
            enabled: default_pool_enabled(),
            max_sessions: default_max_sessions(),
            idle_timeout_minutes: default_idle_timeout_minutes(),
            warmup_on_startup: Vec::new(),
        }
    }
}

fn default_pool_enabled() -> bool {
    true
}

fn default_max_sessions() -> usize {
    5
}

fn default_idle_timeout_minutes() -> u64 {
    15
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_config_default_values() {
        let cfg = PoolConfig::default();
        assert!(cfg.enabled, "pool should be enabled by default");
        assert_eq!(cfg.max_sessions, 5, "default max_sessions should be 5");
        assert_eq!(
            cfg.idle_timeout_minutes, 15,
            "default idle_timeout_minutes should be 15"
        );
        assert!(
            cfg.warmup_on_startup.is_empty(),
            "warmup_on_startup should be empty by default"
        );
    }

    #[test]
    fn pool_config_deserializes_with_defaults_from_toml() {
        // Minimal TOML — serde defaults fill in the rest.
        let toml_str = r#"enabled = false"#;
        let cfg: PoolConfig = toml::from_str(toml_str).unwrap();
        assert!(!cfg.enabled);
        assert_eq!(cfg.max_sessions, 5);
        assert_eq!(cfg.idle_timeout_minutes, 15);
        assert!(cfg.warmup_on_startup.is_empty());
    }

    #[test]
    fn pool_config_warmup_list_parses() {
        let toml_str = r#"
            enabled = true
            max_sessions = 10
            idle_timeout_minutes = 30
            warmup_on_startup = ["oo", "nx"]
        "#;
        let cfg: PoolConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(cfg.max_sessions, 10);
        assert_eq!(cfg.idle_timeout_minutes, 30);
        assert_eq!(cfg.warmup_on_startup, vec!["oo", "nx"]);
    }
}
