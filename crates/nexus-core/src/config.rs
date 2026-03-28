use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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
        dirs_path().join("agents.toml")
    }

    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
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
        dirs_path().join("notifications.toml")
    }

    /// Load from ~/.config/nexus/notifications.toml.
    /// Returns `Ok(Default::default())` if the file does not exist.
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
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

fn dirs_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".config/nexus")
}
