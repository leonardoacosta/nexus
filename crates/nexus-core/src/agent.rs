use serde::{Deserialize, Serialize};

use crate::health::MachineHealth;
use crate::session::Session;

/// Static identity fields for a nexus agent (name, host, port, os).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentIdentity {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub os: String,
}

/// A nexus agent snapshot: identity plus dynamic state (sessions, health, connectivity).
/// The TUI aggregates sessions from all known agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSnapshot {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub os: String,
    pub sessions: Vec<Session>,
    pub health: Option<MachineHealth>,
    pub connected: bool,
}
