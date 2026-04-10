use std::collections::VecDeque;

use chrono::{DateTime, Utc};
use ratatui::style::Color;

use nexus_core::agent::AgentSnapshot;
use nexus_core::session::Session;

use crate::theme::colors;

// ---------------------------------------------------------------------------
// Agent data for TUI state
// ---------------------------------------------------------------------------

/// Aggregated data for a single agent, received from the polling task.
#[derive(Debug, Clone)]
pub struct AgentData {
    pub info: AgentSnapshot,
    pub sessions: Vec<Session>,
    pub connected: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    /// `Some(n)` when the agent is actively reconnecting (n = attempt number).
    pub reconnect_attempt: Option<u32>,
    /// True when the disconnect was caused by DNS resolution failure (no retry).
    pub dns_failure: bool,
}

// ---------------------------------------------------------------------------
// Flattened session row for dashboard display
// ---------------------------------------------------------------------------

/// A session with its owning agent name attached, used for flat list rendering.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session: Session,
    pub agent_name: String,
    pub disconnected: bool,
}

/// A synthetic row shown in the dashboard when an agent is offline/unreachable.
/// Task 5.1/5.2: These rows are injected into the flat list when an agent has no sessions
/// and is not connected, so the user knows the agent is offline.
#[derive(Debug, Clone)]
pub struct AgentOfflineRow {
    pub agent_name: String,
    pub last_seen: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Activity status for project badges
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityStatus {
    Active,  // at least one Active session
    Idle,    // all sessions Idle
    Stale,   // all sessions Stale
    Errored, // any session Errored
    None,    // no sessions
}

impl ActivityStatus {
    /// Return the brand color for this activity status.
    pub fn color(self) -> Color {
        match self {
            ActivityStatus::Active => colors::PRIMARY,
            ActivityStatus::Idle => colors::WARNING,
            ActivityStatus::Stale => colors::TEXT_DIM,
            ActivityStatus::Errored => colors::ERROR,
            ActivityStatus::None => colors::TEXT_DIM,
        }
    }

    /// Return a status dot character for this activity status.
    pub fn dot(self) -> &'static str {
        match self {
            ActivityStatus::Active => "\u{25CF}",  // ●
            ActivityStatus::Idle => "\u{25CB}",    // ○
            ActivityStatus::Stale => "\u{25CC}",   // ◌
            ActivityStatus::Errored => "\u{2716}", // ✖
            ActivityStatus::None => "\u{25CC}",    // ◌
        }
    }
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

/// Sync status for a project's git repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncStatus {
    Synced,
    Behind,
    #[default]
    Unknown,
}

// ---------------------------------------------------------------------------
// Health history ring buffer
// ---------------------------------------------------------------------------

/// Ring-buffer holding ~1 hour of CPU and RAM history (1800 samples at 2s intervals).
#[derive(Debug, Clone)]
pub struct AgentHealthHistory {
    /// CPU utilization samples as integer percentages (0–100).
    pub cpu: VecDeque<u64>,
    /// RAM utilization samples as integer percentages (0–100).
    pub ram: VecDeque<u64>,
}

impl AgentHealthHistory {
    const CAPACITY: usize = 1800;

    pub fn new() -> Self {
        Self {
            cpu: VecDeque::with_capacity(Self::CAPACITY),
            ram: VecDeque::with_capacity(Self::CAPACITY),
        }
    }

    pub fn push_cpu(&mut self, value: u64) {
        if self.cpu.len() >= Self::CAPACITY {
            self.cpu.pop_front();
        }
        self.cpu.push_back(value);
    }

    pub fn push_ram(&mut self, value: u64) {
        if self.ram.len() >= Self::CAPACITY {
            self.ram.pop_front();
        }
        self.ram.push_back(value);
    }
}
