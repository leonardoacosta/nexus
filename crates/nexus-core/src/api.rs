use serde::{Deserialize, Serialize};

use crate::health::MachineHealth;
use crate::session::Session;

// -- Agent API request/response types --

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionListResponse {
    pub sessions: Vec<Session>,
    pub agent_name: String,
    pub agent_host: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub agent_name: String,
    pub agent_host: String,
    pub uptime_seconds: u64,
    pub session_count: usize,
    pub machine: Option<MachineHealth>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterSessionRequest {
    pub pid: u32,
    pub cwd: String,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub tmux_session: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HeartbeatRequest {
    pub session_id: String,
    pub spec: Option<String>,
    pub command: Option<String>,
    pub agent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StopSessionRequest {
    pub session_id: String,
}

// -- WebSocket event types --

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Registered { session: Session },
    Heartbeat { session_id: String },
    Deregistered { session_id: String },
    StatusChanged { session_id: String, status: String },
}
