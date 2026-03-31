use serde::{Deserialize, Serialize};

use crate::health::MachineHealth;

// -- Agent API request/response types --

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub agent_name: String,
    pub agent_host: String,
    pub uptime_seconds: u64,
    pub session_count: usize,
    pub machine: Option<MachineHealth>,
}
