//! Centralised `From` conversions between domain types and generated protobuf
//! types.
//!
//! These were previously duplicated in nexus-agent (`session_to_proto`, etc.)
//! and nexus-tui (`proto_to_session`, etc.).

use chrono::{DateTime, Utc};

use crate::command::{CommandInfo, CommandTier, CostCategory};
use crate::health::{ContainerStatus, MachineHealth};
use crate::proto;
use crate::session::{Session, SessionStatus, SessionType};

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

/// Convert a `chrono::DateTime<Utc>` to a `prost_types::Timestamp`.
pub fn datetime_to_timestamp(dt: &DateTime<Utc>) -> Option<prost_types::Timestamp> {
    Some(prost_types::Timestamp {
        seconds: dt.timestamp(),
        nanos: dt.timestamp_subsec_nanos() as i32,
    })
}

/// Convert a `prost_types::Timestamp` to a `chrono::DateTime<Utc>`.
///
/// Falls back to `Utc::now()` if the timestamp cannot be represented.
pub fn timestamp_to_datetime(ts: &prost_types::Timestamp) -> DateTime<Utc> {
    DateTime::from_timestamp(ts.seconds, ts.nanos as u32).unwrap_or_else(Utc::now)
}

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

/// Convert a domain `SessionStatus` to the proto i32 representation.
pub fn session_status_to_proto(status: &SessionStatus) -> i32 {
    match status {
        SessionStatus::Active => proto::SessionStatus::Active.into(),
        SessionStatus::Idle => proto::SessionStatus::Idle.into(),
        SessionStatus::Stale => proto::SessionStatus::Stale.into(),
        SessionStatus::Errored => proto::SessionStatus::Errored.into(),
    }
}

/// Convert a proto i32 status value back to a domain `SessionStatus`.
pub fn proto_to_session_status(value: i32) -> SessionStatus {
    match value {
        1 => SessionStatus::Active,
        2 => SessionStatus::Idle,
        3 => SessionStatus::Stale,
        4 => SessionStatus::Errored,
        _ => SessionStatus::Active,
    }
}

// ---------------------------------------------------------------------------
// SessionType
// ---------------------------------------------------------------------------

fn session_type_to_proto(st: &SessionType) -> i32 {
    match st {
        SessionType::Managed => proto::SessionType::Managed.into(),
        SessionType::AdHoc => proto::SessionType::AdHoc.into(),
        SessionType::Pooled => proto::SessionType::Pooled.into(),
    }
}

fn proto_to_session_type(value: i32) -> SessionType {
    match proto::SessionType::try_from(value) {
        Ok(proto::SessionType::Managed) => SessionType::Managed,
        Ok(proto::SessionType::AdHoc) => SessionType::AdHoc,
        Ok(proto::SessionType::Pooled) => SessionType::Pooled,
        _ => SessionType::AdHoc,
    }
}

// ---------------------------------------------------------------------------
// Session ↔ proto::Session
// ---------------------------------------------------------------------------

impl From<&Session> for proto::Session {
    fn from(session: &Session) -> Self {
        // Build telemetry sub-message if any telemetry fields are populated.
        let telemetry = if session.rate_limit_utilization.is_some()
            || session.total_cost_usd.is_some()
            || session.model.is_some()
        {
            let rate_limit = session
                .rate_limit_utilization
                .map(|util| proto::RateLimitInfo {
                    utilization_percent: util,
                    rate_limit_type: session
                        .rate_limit_type
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    surpassed_threshold: util >= 0.75,
                });

            Some(proto::SessionTelemetry {
                rate_limit,
                total_cost_usd: session.total_cost_usd,
                model: session.model.clone(),
            })
        } else {
            None
        };

        proto::Session {
            id: session.id.clone(),
            pid: session.pid,
            project: session.project.clone(),
            cwd: session.cwd.clone(),
            branch: session.branch.clone(),
            started_at: datetime_to_timestamp(&session.started_at),
            last_heartbeat: datetime_to_timestamp(&session.last_heartbeat),
            status: session_status_to_proto(&session.status),
            session_type: session_type_to_proto(&session.session_type),
            spec: session.spec.clone(),
            command: session.command.clone(),
            agent: session.agent.clone(),
            tmux_session: session.tmux_session.clone(),
            cc_session_id: session.cc_session_id.clone(),
            telemetry,
            tmux_target: session.tmux_target.clone(),
        }
    }
}

impl From<proto::Session> for Session {
    fn from(proto: proto::Session) -> Self {
        let started_at = proto
            .started_at
            .as_ref()
            .map(timestamp_to_datetime)
            .unwrap_or_else(Utc::now);

        let last_heartbeat = proto
            .last_heartbeat
            .as_ref()
            .map(timestamp_to_datetime)
            .unwrap_or_else(Utc::now);

        let status = proto_to_session_status(proto.status);
        let session_type = proto_to_session_type(proto.session_type);

        // Extract telemetry fields.
        let (rate_limit_utilization, rate_limit_type, total_cost_usd, model) =
            if let Some(ref telemetry) = proto.telemetry {
                let (rl_util, rl_type) = if let Some(ref rl) = telemetry.rate_limit {
                    (
                        Some(rl.utilization_percent),
                        Some(rl.rate_limit_type.clone()),
                    )
                } else {
                    (None, None)
                };
                (
                    rl_util,
                    rl_type,
                    telemetry.total_cost_usd,
                    telemetry.model.clone(),
                )
            } else {
                (None, None, None, None)
            };

        Session {
            id: proto.id,
            pid: proto.pid,
            project: proto.project,
            cwd: proto.cwd,
            branch: proto.branch,
            started_at,
            last_heartbeat,
            status,
            spec: proto.spec,
            command: proto.command,
            agent: proto.agent,
            tmux_session: proto.tmux_session,
            cc_session_id: proto.cc_session_id,
            tmux_target: proto.tmux_target,
            rate_limit_utilization,
            rate_limit_type,
            total_cost_usd,
            model,
            session_type,
        }
    }
}

// ---------------------------------------------------------------------------
// MachineHealth ↔ proto::MachineHealth
// ---------------------------------------------------------------------------

impl From<&MachineHealth> for proto::MachineHealth {
    fn from(health: &MachineHealth) -> Self {
        proto::MachineHealth {
            cpu_percent: health.cpu_percent,
            memory_used_gb: health.memory_used_gb,
            memory_total_gb: health.memory_total_gb,
            disk_used_gb: health.disk_used_gb,
            disk_total_gb: health.disk_total_gb,
            load_avg: health.load_avg.to_vec(),
            uptime_seconds: health.uptime_seconds,
            docker_containers: health
                .docker_containers
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|c| proto::ContainerStatus {
                    name: c.name.clone(),
                    running: c.running,
                })
                .collect(),
        }
    }
}

impl From<proto::MachineHealth> for MachineHealth {
    fn from(proto: proto::MachineHealth) -> Self {
        let load_avg = if proto.load_avg.len() >= 3 {
            [proto.load_avg[0], proto.load_avg[1], proto.load_avg[2]]
        } else {
            [0.0; 3]
        };

        let docker_containers = if proto.docker_containers.is_empty() {
            None
        } else {
            Some(
                proto
                    .docker_containers
                    .into_iter()
                    .map(|c| ContainerStatus {
                        name: c.name,
                        running: c.running,
                    })
                    .collect(),
            )
        };

        MachineHealth {
            cpu_percent: proto.cpu_percent,
            memory_used_gb: proto.memory_used_gb,
            memory_total_gb: proto.memory_total_gb,
            disk_used_gb: proto.disk_used_gb,
            disk_total_gb: proto.disk_total_gb,
            load_avg,
            uptime_seconds: proto.uptime_seconds,
            docker_containers,
        }
    }
}

// ---------------------------------------------------------------------------
// CommandInfo ↔ proto::CommandInfoProto
// ---------------------------------------------------------------------------

impl From<&CommandInfo> for proto::CommandInfoProto {
    fn from(info: &CommandInfo) -> Self {
        proto::CommandInfoProto {
            name: info.name.clone(),
            namespace: info.namespace.clone(),
            full_name: info.full_name.clone(),
            description: info.description.clone(),
            tier: match info.tier {
                CommandTier::Status => proto::CommandTier::Status.into(),
                CommandTier::Analysis => proto::CommandTier::Analysis.into(),
                CommandTier::Action => proto::CommandTier::Action.into(),
            },
            cost: match info.cost {
                CostCategory::Minimal => proto::CostCategory::Minimal.into(),
                CostCategory::Low => proto::CostCategory::Low.into(),
                CostCategory::Medium => proto::CostCategory::Medium.into(),
                CostCategory::High => proto::CostCategory::High.into(),
            },
        }
    }
}

impl From<proto::CommandInfoProto> for CommandInfo {
    fn from(proto: proto::CommandInfoProto) -> Self {
        let tier = match proto::CommandTier::try_from(proto.tier) {
            Ok(proto::CommandTier::Status) => CommandTier::Status,
            Ok(proto::CommandTier::Analysis) => CommandTier::Analysis,
            Ok(proto::CommandTier::Action) => CommandTier::Action,
            _ => CommandTier::Status,
        };

        let cost = match proto::CostCategory::try_from(proto.cost) {
            Ok(proto::CostCategory::Minimal) => CostCategory::Minimal,
            Ok(proto::CostCategory::Low) => CostCategory::Low,
            Ok(proto::CostCategory::Medium) => CostCategory::Medium,
            Ok(proto::CostCategory::High) => CostCategory::High,
            _ => CostCategory::Minimal,
        };

        CommandInfo {
            name: proto.name,
            namespace: proto.namespace,
            full_name: proto.full_name,
            description: proto.description,
            tier,
            cost,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Session;

    #[test]
    fn session_round_trip() {
        let now = Utc::now();
        let session = Session {
            id: "test-id".to_string(),
            pid: 1234,
            project: Some("nx".to_string()),
            cwd: "/home/user/dev/nx".to_string(),
            branch: Some("main".to_string()),
            started_at: now,
            last_heartbeat: now,
            status: SessionStatus::Active,
            spec: Some("my-spec".to_string()),
            command: Some("/apply".to_string()),
            agent: Some("engineer".to_string()),
            tmux_session: Some("nexus-1".to_string()),
            cc_session_id: Some("cc-123".to_string()),
            tmux_target: Some("main:0.1".to_string()),
            rate_limit_utilization: Some(0.5),
            rate_limit_type: Some("api_key".to_string()),
            total_cost_usd: Some(1.23),
            model: Some("opus-4".to_string()),
            session_type: SessionType::Managed,
        };

        let proto_session: proto::Session = (&session).into();
        let restored: Session = proto_session.into();

        assert_eq!(restored.id, session.id);
        assert_eq!(restored.pid, session.pid);
        assert_eq!(restored.project, session.project);
        assert_eq!(restored.cwd, session.cwd);
        assert_eq!(restored.branch, session.branch);
        assert_eq!(restored.status, session.status);
        assert_eq!(restored.spec, session.spec);
        assert_eq!(restored.command, session.command);
        assert_eq!(restored.agent, session.agent);
        assert_eq!(restored.tmux_session, session.tmux_session);
        assert_eq!(restored.cc_session_id, session.cc_session_id);
        assert_eq!(restored.tmux_target, session.tmux_target);
        assert_eq!(restored.session_type, session.session_type);
        assert_eq!(
            restored.rate_limit_utilization,
            session.rate_limit_utilization
        );
        assert_eq!(restored.rate_limit_type, session.rate_limit_type);
        assert_eq!(restored.model, session.model);
    }

    #[test]
    fn session_type_maps_correctly() {
        for (domain_type, expected_proto) in [
            (SessionType::Managed, proto::SessionType::Managed as i32),
            (SessionType::AdHoc, proto::SessionType::AdHoc as i32),
            (SessionType::Pooled, proto::SessionType::Pooled as i32),
        ] {
            let session = Session {
                session_type: domain_type,
                ..Session::new(0, "/tmp".into())
            };
            let proto_session: proto::Session = (&session).into();
            assert_eq!(
                proto_session.session_type, expected_proto,
                "domain {:?} should map to proto value {}",
                domain_type, expected_proto
            );

            let restored: Session = proto_session.into();
            assert_eq!(
                restored.session_type, domain_type,
                "proto value should round-trip back to {:?}",
                domain_type
            );
        }
    }

    #[test]
    fn tmux_target_preserved() {
        let mut session = Session::new(42, "/tmp".into());
        session.tmux_target = Some("main:0.1".to_string());

        let proto_session: proto::Session = (&session).into();
        assert_eq!(proto_session.tmux_target, Some("main:0.1".to_string()));

        let restored: Session = proto_session.into();
        assert_eq!(restored.tmux_target, Some("main:0.1".to_string()));
    }

    #[test]
    fn machine_health_round_trip() {
        let health = MachineHealth {
            cpu_percent: 45.5,
            memory_used_gb: 8.0,
            memory_total_gb: 16.0,
            disk_used_gb: 100.0,
            disk_total_gb: 500.0,
            load_avg: [1.0, 2.0, 3.0],
            uptime_seconds: 86400,
            docker_containers: Some(vec![ContainerStatus {
                name: "postgres".to_string(),
                running: true,
            }]),
        };

        let proto_health: proto::MachineHealth = (&health).into();
        let restored: MachineHealth = proto_health.into();

        assert_eq!(restored.cpu_percent, health.cpu_percent);
        assert_eq!(restored.memory_used_gb, health.memory_used_gb);
        assert_eq!(restored.memory_total_gb, health.memory_total_gb);
        assert_eq!(restored.disk_used_gb, health.disk_used_gb);
        assert_eq!(restored.disk_total_gb, health.disk_total_gb);
        assert_eq!(restored.load_avg, health.load_avg);
        assert_eq!(restored.uptime_seconds, health.uptime_seconds);
        assert!(restored.docker_containers.is_some());
        let containers = restored.docker_containers.unwrap();
        assert_eq!(containers.len(), 1);
        assert_eq!(containers[0].name, "postgres");
        assert!(containers[0].running);
    }

    #[test]
    fn machine_health_load_avg_padding() {
        // Proto with fewer than 3 load_avg values should pad with zeros.
        let proto_health = proto::MachineHealth {
            cpu_percent: 10.0,
            memory_used_gb: 4.0,
            memory_total_gb: 8.0,
            disk_used_gb: 50.0,
            disk_total_gb: 200.0,
            load_avg: vec![1.5],
            uptime_seconds: 3600,
            docker_containers: vec![],
        };

        let restored: MachineHealth = proto_health.into();
        assert_eq!(restored.load_avg, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn command_info_to_proto() {
        let info = CommandInfo {
            name: "code".to_string(),
            namespace: "audit".to_string(),
            full_name: "audit:code".to_string(),
            description: "Audit code quality".to_string(),
            tier: CommandTier::Analysis,
            cost: CostCategory::High,
        };

        let proto_info: proto::CommandInfoProto = (&info).into();
        assert_eq!(proto_info.name, "code");
        assert_eq!(proto_info.namespace, "audit");
        assert_eq!(proto_info.full_name, "audit:code");
        assert_eq!(proto_info.description, "Audit code quality");
        assert_eq!(proto_info.tier, proto::CommandTier::Analysis as i32);
        assert_eq!(proto_info.cost, proto::CostCategory::High as i32);
    }

    #[test]
    fn command_info_round_trip() {
        let info = CommandInfo {
            name: "code".to_string(),
            namespace: "audit".to_string(),
            full_name: "audit:code".to_string(),
            description: "Audit code quality".to_string(),
            tier: CommandTier::Analysis,
            cost: CostCategory::High,
        };

        let proto_info: proto::CommandInfoProto = (&info).into();
        let restored: CommandInfo = proto_info.into();

        assert_eq!(restored.name, info.name);
        assert_eq!(restored.namespace, info.namespace);
        assert_eq!(restored.full_name, info.full_name);
        assert_eq!(restored.description, info.description);
        assert_eq!(restored.tier, info.tier);
        assert_eq!(restored.cost, info.cost);
    }

    #[test]
    fn session_status_round_trip() {
        for status in [
            SessionStatus::Active,
            SessionStatus::Idle,
            SessionStatus::Stale,
            SessionStatus::Errored,
        ] {
            let proto_val = session_status_to_proto(&status);
            let restored = proto_to_session_status(proto_val);
            assert_eq!(restored, status, "status {:?} should round-trip", status);
        }
    }

    #[test]
    fn timestamp_round_trip() {
        let now = Utc::now();
        let ts = datetime_to_timestamp(&now).unwrap();
        let restored = timestamp_to_datetime(&ts);
        // Allow up to 1 second of difference due to nanosecond truncation.
        let diff = (now - restored).num_milliseconds().unsigned_abs();
        assert!(
            diff < 1000,
            "timestamp round-trip should be within 1s, got {}ms",
            diff
        );
    }
}
