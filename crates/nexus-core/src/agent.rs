use serde::{Deserialize, Serialize};

use crate::health::MachineHealth;
use crate::session::Session;

/// A nexus agent running on a specific machine.
/// The TUI aggregates sessions from all known agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub os: String,
    pub sessions: Vec<Session>,
    pub health: Option<MachineHealth>,
    pub connected: bool,
}
