//! Higher-level lifecycle events consumed by the NotificationEngine.
//!
//! These are distinct from the low-level gRPC `SessionEvent` protos. They are
//! produced by two sources:
//!
//! - `EventForwarder`: converts remote gRPC `SessionEvent` protos from peer agents
//!   into `LifecycleEvent` values.
//! - The local socket listener: converts `SocketEvent` variants (AgentSpawn,
//!   AgentComplete, Notification, SessionStart, SessionStop) into `LifecycleEvent`.
//!
//! The `NotificationEngine` consumes these events, applies per-project rules from
//! `NotificationConfig`, constructs human-readable messages, and delivers them via
//! `ReceiverService::speak_from_socket`.

use serde::{Deserialize, Serialize};

/// A higher-level lifecycle event with all context needed for notification construction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LifecycleEvent {
    /// Which nexus-agent emitted this event (e.g. "homelab", "macbook").
    pub source_agent: String,
    /// Project code extracted from the session cwd or annotation (e.g. "oo", "cc").
    /// Empty string if unknown.
    pub project: String,
    /// The kind of lifecycle transition.
    pub kind: LifecycleEventKind,
}

/// The specific kind of lifecycle event.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LifecycleEventKind {
    /// A Claude Code session started on the source agent.
    SessionStart {
        session_id: String,
        model: Option<String>,
        cwd: String,
    },
    /// A Claude Code session ended on the source agent.
    SessionStop {
        session_id: String,
        /// Approximate session duration in seconds (0 if unknown).
        duration_s: u64,
    },
    /// A sub-agent was spawned within a session.
    AgentSpawn {
        agent_type: String,
        model: Option<String>,
    },
    /// A sub-agent completed its work.
    AgentComplete {
        agent_type: String,
        /// Agent wall-clock time in milliseconds.
        duration_ms: u64,
        /// Tasks marked complete during this agent run.
        tasks_done: u32,
        /// Total tasks in the spec (0 if unknown).
        tasks_total: u32,
    },
    /// A spec was fully completed (all tasks done).
    SpecComplete {
        spec_name: String,
        tasks_total: u32,
    },
    /// An error occurred that should always be announced.
    Error {
        message: String,
        /// Severity string (e.g. "critical", "warning").
        severity: String,
    },
    /// A raw notification from the socket pipeline (forwarded as-is or suppressed
    /// based on project rules when the source is a remote agent).
    Notification {
        message: String,
        channels: Vec<String>,
        message_type: String,
    },
}

impl LifecycleEvent {
    /// Construct a SessionStart event.
    pub fn session_start(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        session_id: impl Into<String>,
        model: Option<String>,
        cwd: impl Into<String>,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::SessionStart {
                session_id: session_id.into(),
                model,
                cwd: cwd.into(),
            },
        }
    }

    /// Construct a SessionStop event.
    pub fn session_stop(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        session_id: impl Into<String>,
        duration_s: u64,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::SessionStop {
                session_id: session_id.into(),
                duration_s,
            },
        }
    }

    /// Construct an AgentSpawn event.
    pub fn agent_spawn(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        agent_type: impl Into<String>,
        model: Option<String>,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::AgentSpawn {
                agent_type: agent_type.into(),
                model,
            },
        }
    }

    /// Construct an AgentComplete event.
    pub fn agent_complete(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        agent_type: impl Into<String>,
        duration_ms: u64,
        tasks_done: u32,
        tasks_total: u32,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::AgentComplete {
                agent_type: agent_type.into(),
                duration_ms,
                tasks_done,
                tasks_total,
            },
        }
    }

    /// Construct a SpecComplete event.
    pub fn spec_complete(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        spec_name: impl Into<String>,
        tasks_total: u32,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::SpecComplete {
                spec_name: spec_name.into(),
                tasks_total,
            },
        }
    }

    /// Construct an Error event.
    pub fn error(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        message: impl Into<String>,
        severity: impl Into<String>,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::Error {
                message: message.into(),
                severity: severity.into(),
            },
        }
    }

    /// Construct a Notification passthrough event.
    pub fn notification(
        source_agent: impl Into<String>,
        project: impl Into<String>,
        message: impl Into<String>,
        channels: Vec<String>,
        message_type: impl Into<String>,
    ) -> Self {
        Self {
            source_agent: source_agent.into(),
            project: project.into(),
            kind: LifecycleEventKind::Notification {
                message: message.into(),
                channels,
                message_type: message_type.into(),
            },
        }
    }
}

/// Extract a project code from a filesystem path.
///
/// Looks for the last path component that matches a known project code pattern:
/// two-letter or short lowercase codes like "oo", "tc", "cc", "tl", etc.
/// Falls back to the last path component if nothing matches, or empty string.
pub fn project_from_cwd(cwd: &str) -> String {
    let path = std::path::Path::new(cwd);

    // Walk from the deepest component upward. Project dirs are typically
    // ~/dev/<code>/<...>. We look for a component that follows "dev" or is
    // 2-4 lowercase letters (common project code length).
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| {
            if let std::path::Component::Normal(os) = c {
                os.to_str()
            } else {
                None
            }
        })
        .collect();

    // Find "dev" component and take the next one.
    for (i, comp) in components.iter().enumerate() {
        if *comp == "dev" {
            if let Some(project) = components.get(i + 1) {
                return project.to_string();
            }
        }
    }

    // Fall back: last component if short enough to be a project code.
    if let Some(last) = components.last() {
        if last.len() <= 6 && last.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
            return last.to_string();
        }
    }

    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_from_cwd_dev_path() {
        assert_eq!(project_from_cwd("/home/nyaptor/dev/oo/apps/web"), "oo");
        assert_eq!(project_from_cwd("/home/nyaptor/dev/cc"), "cc");
        assert_eq!(project_from_cwd("/home/nyaptor/dev/nexus/crates"), "nexus");
    }

    #[test]
    fn test_project_from_cwd_no_dev() {
        assert_eq!(project_from_cwd("/tmp"), "tmp");
        assert_eq!(project_from_cwd("/home/user"), "");
    }

    #[test]
    fn test_session_start_constructor() {
        let ev = LifecycleEvent::session_start(
            "homelab",
            "oo",
            "sess-1",
            Some("claude-opus-4".to_string()),
            "/home/nyaptor/dev/oo",
        );
        assert_eq!(ev.source_agent, "homelab");
        assert_eq!(ev.project, "oo");
        matches!(ev.kind, LifecycleEventKind::SessionStart { .. });
    }

    #[test]
    fn test_agent_complete_constructor() {
        let ev = LifecycleEvent::agent_complete("macbook", "tl", "ui-engineer", 45000, 3, 5);
        assert_eq!(ev.source_agent, "macbook");
        match ev.kind {
            LifecycleEventKind::AgentComplete {
                agent_type,
                duration_ms,
                tasks_done,
                tasks_total,
            } => {
                assert_eq!(agent_type, "ui-engineer");
                assert_eq!(duration_ms, 45000);
                assert_eq!(tasks_done, 3);
                assert_eq!(tasks_total, 5);
            }
            _ => panic!("wrong variant"),
        }
    }
}