use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Events emitted by Claude Code hooks via the Unix domain socket.
///
/// Each event is a single line of newline-delimited JSON. The `event` field
/// acts as a discriminant tag for serde's externally-tagged representation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SocketEvent {
    /// A new Claude Code session has started.
    SessionStart {
        session_id: String,
        #[serde(default)]
        project: Option<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        pid: Option<u32>,
        #[serde(default)]
        branch: Option<String>,
        #[serde(default)]
        cc_session_id: Option<String>,
    },

    /// An active Claude Code session has ended.
    SessionStop { session_id: String },

    /// Periodic heartbeat to keep the session marked as active.
    SessionHeartbeat { session_id: String },

    /// A user-visible notification to be delivered via TTS / APNs / banner.
    Notification {
        message: String,
        #[serde(default)]
        message_type: Option<String>,
        #[serde(default)]
        channels: Option<Vec<String>>,
    },

    /// A sub-agent has been spawned within a session.
    AgentSpawn {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        agent_type: Option<String>,
        #[serde(default)]
        model: Option<String>,
    },

    /// A sub-agent has finished executing.
    AgentComplete {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        agent_type: Option<String>,
        #[serde(default)]
        duration_ms: Option<u64>,
    },

    /// Structured telemetry data (cost, rate-limit, token counts, etc.).
    Telemetry {
        #[serde(default)]
        payload: HashMap<String, serde_json::Value>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_start() {
        let json = r#"{"event":"session_start","session_id":"abc","project":"oo","cwd":"/home/nyaptor/dev/oo","model":"opus","pid":12345}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        match ev {
            SocketEvent::SessionStart {
                session_id,
                project,
                model,
                pid,
                ..
            } => {
                assert_eq!(session_id, "abc");
                assert_eq!(project.as_deref(), Some("oo"));
                assert_eq!(model.as_deref(), Some("opus"));
                assert_eq!(pid, Some(12345));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn parse_session_stop() {
        let json = r#"{"event":"session_stop","session_id":"xyz"}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(ev, SocketEvent::SessionStop { session_id } if session_id == "xyz"));
    }

    #[test]
    fn parse_session_heartbeat() {
        let json = r#"{"event":"session_heartbeat","session_id":"abc"}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(ev, SocketEvent::SessionHeartbeat { session_id } if session_id == "abc"));
    }

    #[test]
    fn parse_notification() {
        let json = r#"{"event":"notification","message":"done","message_type":"brief","channels":["tts"]}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        match ev {
            SocketEvent::Notification {
                message,
                message_type,
                channels,
            } => {
                assert_eq!(message, "done");
                assert_eq!(message_type.as_deref(), Some("brief"));
                assert_eq!(channels.as_deref(), Some(["tts".to_string()].as_slice()));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn parse_agent_spawn() {
        let json = r#"{"event":"agent_spawn","session_id":"abc","agent_type":"ui-engineer","model":"sonnet"}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(ev, SocketEvent::AgentSpawn { .. }));
    }

    #[test]
    fn parse_agent_complete() {
        let json = r#"{"event":"agent_complete","session_id":"abc","agent_type":"ui-engineer","duration_ms":5000}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(
            ev,
            SocketEvent::AgentComplete {
                duration_ms: Some(5000),
                ..
            }
        ));
    }

    #[test]
    fn parse_telemetry() {
        let json = r#"{"event":"telemetry","payload":{"cost_usd":0.12}}"#;
        let ev: SocketEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(ev, SocketEvent::Telemetry { .. }));
    }
}