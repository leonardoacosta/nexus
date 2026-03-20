use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Nexus configuration, loaded from ~/.config/nexus/agents.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NexusConfig {
    pub agents: Vec<AgentConfig>,
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
}

fn dirs_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".config/nexus")
}
