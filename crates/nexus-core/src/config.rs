use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::paths::nexus_config_dir;

/// Errors that can occur when loading or saving Nexus configuration files.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
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
    /// IP address for the agent daemon to bind gRPC and HTTP servers on.
    /// Defaults to "127.0.0.1" for security (localhost only). Set to "0.0.0.0"
    /// to accept connections from the network (e.g. via Tailscale).
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    /// Optional shared secret for authenticating sensitive HTTP endpoints
    /// (e.g. `/project/{code}/run`). When set, requests must include an
    /// `X-Nexus-Secret` header matching this value. Can also be provided
    /// via the `NEXUS_SECRET` environment variable (which takes precedence).
    #[serde(default)]
    pub secret: Option<String>,
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
    crate::DEFAULT_GRPC_PORT
}

fn default_bind_address() -> String {
    "127.0.0.1".to_string()
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

    /// Return the effective secret, preferring `NEXUS_SECRET` env var over
    /// the config file value.
    pub fn effective_secret(&self) -> Option<String> {
        std::env::var("NEXUS_SECRET")
            .ok()
            .or_else(|| self.secret.clone())
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

    /// Serialize this config to TOML and write it back to
    /// `~/.config/nexus/notifications.toml`.
    ///
    /// Creates the parent directory if it does not exist.
    pub fn save(&self) -> Result<(), ConfigError> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let toml_str = toml::to_string_pretty(self)?;
        std::fs::write(&path, toml_str)?;
        Ok(())
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

    // -------------------------------------------------------------------------
    // bind_address + secret (Spec 4 — secure agent endpoints)
    // -------------------------------------------------------------------------

    #[test]
    fn default_bind_address_is_localhost() {
        let toml_str = r#"
            agents = []
        "#;
        let cfg: NexusConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(
            cfg.bind_address, "127.0.0.1",
            "bind_address should default to 127.0.0.1"
        );
    }

    #[test]
    fn explicit_bind_address_override() {
        let toml_str = r#"
            agents = []
            bind_address = "0.0.0.0"
        "#;
        let cfg: NexusConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(cfg.bind_address, "0.0.0.0");
    }

    #[test]
    fn secret_defaults_to_none() {
        let toml_str = r#"
            agents = []
        "#;
        let cfg: NexusConfig = toml::from_str(toml_str).unwrap();
        assert!(cfg.secret.is_none(), "secret should default to None");
    }

    #[test]
    fn secret_from_config_file() {
        let toml_str = r#"
            agents = []
            secret = "s3cret-t0ken"
        "#;
        let cfg: NexusConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(cfg.secret.as_deref(), Some("s3cret-t0ken"));
    }

    #[test]
    fn effective_secret_prefers_env_var() {
        let cfg = NexusConfig {
            agents: vec![],
            role: AgentRole::Primary,
            self_name: None,
            pool: None,
            bind_address: "127.0.0.1".to_string(),
            secret: Some("from-config".to_string()),
        };

        // Without the env var, falls back to config.
        // NOTE: env var tests are inherently global — only safe because cargo
        // test runs each test in its own thread and we clean up.
        // SAFETY: Single-threaded test, no concurrent env var access.
        unsafe { std::env::remove_var("NEXUS_SECRET") };
        assert_eq!(cfg.effective_secret().as_deref(), Some("from-config"));

        // With the env var, it takes precedence.
        unsafe { std::env::set_var("NEXUS_SECRET", "from-env") };
        assert_eq!(cfg.effective_secret().as_deref(), Some("from-env"));
        unsafe { std::env::remove_var("NEXUS_SECRET") };
    }

    // -------------------------------------------------------------------------
    // NotificationConfig — save / rules_for
    // -------------------------------------------------------------------------

    #[test]
    fn notification_config_roundtrip_save_load() {
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
    fn notification_config_rules_for_fallback() {
        let config = NotificationConfig::default();
        let rules = config.rules_for("unknown-project");
        assert_eq!(rules.verbosity, Verbosity::Brief);
        assert!(!rules.announce_agents);
        assert!(rules.announce_specs);
    }
}
