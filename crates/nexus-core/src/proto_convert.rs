//! Centralised `From` conversions between domain types and generated protobuf
//! types.
//!
//! These were previously duplicated in nexus-agent (`session_to_proto`, etc.)
//! and nexus-tui (`proto_to_session`, etc.).

use chrono::{DateTime, Utc};

use crate::command::{CommandInfo, CommandTier, CostCategory};
use crate::health::{
    CpuHealth, DiskHealth, DockerHealth, MachineHealth, NetworkInterface, ProcessEntry,
    ProcessSnapshot, RamHealth,
};
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
        SessionStatus::Ended => proto::SessionStatus::Ended.into(),
    }
}

/// Convert a proto i32 status value back to a domain `SessionStatus`.
pub fn proto_to_session_status(value: i32) -> SessionStatus {
    match value {
        1 => SessionStatus::Active,
        2 => SessionStatus::Idle,
        3 => SessionStatus::Stale,
        4 => SessionStatus::Errored,
        5 => SessionStatus::Ended,
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
            machine: session.machine.clone(),
            ended_at: session.ended_at.as_ref().and_then(datetime_to_timestamp),
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

        let ended_at = proto.ended_at.as_ref().map(timestamp_to_datetime);

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
            machine: proto.machine,
            ended_at,
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
        let cpu = Some(proto::CpuInfo {
            overall_percent: health.cpu.overall_percent,
            per_core_percent: health.cpu.per_core_percent.clone(),
            load_average: health.cpu.load_average.to_vec(),
        });

        let ram = Some(proto::RamInfo {
            total_bytes: health.ram.total_bytes,
            used_bytes: health.ram.used_bytes,
            percent: health.ram.percent,
        });

        let disk: Vec<proto::DiskInfo> = health
            .disk
            .iter()
            .map(|d| proto::DiskInfo {
                mount: d.mount.clone(),
                total_bytes: d.total_bytes,
                used_bytes: d.used_bytes,
                percent: d.percent,
            })
            .collect();

        let docker = health.docker.as_ref().map(|d| proto::DockerInfo {
            containers: d.containers,
            running: d.running,
        });

        // Legacy docker_containers field for backward compat with old TUI clients.
        let docker_containers = if let Some(ref d) = health.docker {
            let stopped = d.containers.saturating_sub(d.running);
            let mut containers: Vec<proto::ContainerStatus> = (0..d.running)
                .map(|i| proto::ContainerStatus {
                    name: format!("container-{i}"),
                    running: true,
                })
                .collect();
            containers.extend((0..stopped).map(|i| proto::ContainerStatus {
                name: format!("stopped-{i}"),
                running: false,
            }));
            containers
        } else {
            vec![]
        };

        let collected_at = health
            .collected_at
            .as_ref()
            .and_then(datetime_to_timestamp);

        let network: Vec<proto::NetworkInterface> = health
            .network
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|n| proto::NetworkInterface {
                iface: n.iface.clone(),
                rx_bytes: n.rx_bytes,
                tx_bytes: n.tx_bytes,
            })
            .collect();

        let processes = health.processes.as_ref().map(|ps| proto::ProcessSnapshot {
            top_cpu: ps
                .top_cpu
                .iter()
                .map(|p| proto::ProcessEntry {
                    pid: p.pid,
                    name: p.name.clone(),
                    cpu_percent: p.cpu_percent,
                    ram_percent: p.ram_percent,
                })
                .collect(),
            top_ram: ps
                .top_ram
                .iter()
                .map(|p| proto::ProcessEntry {
                    pid: p.pid,
                    name: p.name.clone(),
                    cpu_percent: p.cpu_percent,
                    ram_percent: p.ram_percent,
                })
                .collect(),
        });

        proto::MachineHealth {
            hostname: health.hostname.clone(),
            uptime_seconds: health.uptime_seconds,
            cpu,
            ram,
            disk,
            docker,
            docker_containers,
            collected_at,
            network,
            processes,
        }
    }
}

impl From<proto::MachineHealth> for MachineHealth {
    fn from(proto: proto::MachineHealth) -> Self {
        let cpu = if let Some(ref c) = proto.cpu {
            let load_average = if c.load_average.len() >= 3 {
                [c.load_average[0], c.load_average[1], c.load_average[2]]
            } else {
                [0.0; 3]
            };
            CpuHealth {
                overall_percent: c.overall_percent,
                per_core_percent: c.per_core_percent.clone(),
                load_average,
            }
        } else {
            CpuHealth {
                overall_percent: 0.0,
                per_core_percent: Vec::new(),
                load_average: [0.0; 3],
            }
        };

        let ram = if let Some(ref r) = proto.ram {
            RamHealth {
                total_bytes: r.total_bytes,
                used_bytes: r.used_bytes,
                percent: r.percent,
            }
        } else {
            RamHealth {
                total_bytes: 0,
                used_bytes: 0,
                percent: 0.0,
            }
        };

        let disk: Vec<DiskHealth> = proto
            .disk
            .iter()
            .map(|d| DiskHealth {
                mount: d.mount.clone(),
                total_bytes: d.total_bytes,
                used_bytes: d.used_bytes,
                percent: d.percent,
            })
            .collect();

        let docker = proto.docker.as_ref().map(|d| DockerHealth {
            containers: d.containers,
            running: d.running,
        });

        let collected_at = proto.collected_at.as_ref().map(timestamp_to_datetime);

        let network = if proto.network.is_empty() {
            None
        } else {
            Some(
                proto
                    .network
                    .iter()
                    .map(|n| NetworkInterface {
                        iface: n.iface.clone(),
                        rx_bytes: n.rx_bytes,
                        tx_bytes: n.tx_bytes,
                    })
                    .collect(),
            )
        };

        let processes = proto.processes.as_ref().map(|ps| ProcessSnapshot {
            top_cpu: ps
                .top_cpu
                .iter()
                .map(|p| ProcessEntry {
                    pid: p.pid,
                    name: p.name.clone(),
                    cpu_percent: p.cpu_percent,
                    ram_percent: p.ram_percent,
                })
                .collect(),
            top_ram: ps
                .top_ram
                .iter()
                .map(|p| ProcessEntry {
                    pid: p.pid,
                    name: p.name.clone(),
                    cpu_percent: p.cpu_percent,
                    ram_percent: p.ram_percent,
                })
                .collect(),
        });

        MachineHealth {
            hostname: proto.hostname,
            uptime_seconds: proto.uptime_seconds,
            cpu,
            ram,
            disk,
            docker,
            network,
            processes,
            collected_at,
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
        let ended = now + chrono::Duration::minutes(30);
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
            machine: Some("homelab".to_string()),
            ended_at: Some(ended),
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
        assert_eq!(restored.machine, session.machine);
        assert_eq!(restored.session_type, session.session_type);
        assert_eq!(
            restored.rate_limit_utilization,
            session.rate_limit_utilization
        );
        assert_eq!(restored.rate_limit_type, session.rate_limit_type);
        assert_eq!(restored.model, session.model);
        // ended_at round-trip: allow up to 1s difference from timestamp truncation.
        assert!(restored.ended_at.is_some());
        let ended_diff = (restored.ended_at.unwrap() - ended)
            .num_milliseconds()
            .unsigned_abs();
        assert!(
            ended_diff < 1000,
            "ended_at round-trip should be within 1s, got {}ms",
            ended_diff
        );
    }

    #[test]
    fn session_round_trip_none_optional_fields() {
        let now = Utc::now();
        let session = Session {
            id: "no-optionals".to_string(),
            pid: 42,
            project: None,
            cwd: "/tmp".to_string(),
            branch: None,
            started_at: now,
            last_heartbeat: now,
            status: SessionStatus::Idle,
            spec: None,
            command: None,
            agent: None,
            tmux_session: None,
            cc_session_id: None,
            tmux_target: None,
            machine: None,
            ended_at: None,
            rate_limit_utilization: None,
            rate_limit_type: None,
            total_cost_usd: None,
            model: None,
            session_type: SessionType::AdHoc,
        };

        let proto_session: proto::Session = (&session).into();
        assert!(proto_session.machine.is_none());
        assert!(proto_session.ended_at.is_none());

        let restored: Session = proto_session.into();
        assert!(restored.machine.is_none());
        assert!(restored.ended_at.is_none());
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
        use crate::health::{
            CpuHealth, DiskHealth, DockerHealth, NetworkInterface, ProcessEntry, ProcessSnapshot,
            RamHealth,
        };

        let collected = Utc::now();
        let health = MachineHealth {
            hostname: "test-host".to_string(),
            uptime_seconds: 86400,
            cpu: CpuHealth {
                overall_percent: 45.5,
                per_core_percent: vec![40.0, 51.0],
                load_average: [1.0, 2.0, 3.0],
            },
            ram: RamHealth {
                total_bytes: 17_179_869_184, // 16 GB
                used_bytes: 8_589_934_592,   // 8 GB
                percent: 50.0,
            },
            disk: vec![DiskHealth {
                mount: "/".to_string(),
                total_bytes: 536_870_912_000, // 500 GB
                used_bytes: 107_374_182_400,  // 100 GB
                percent: 20.0,
            }],
            docker: Some(DockerHealth {
                containers: 2,
                running: 1,
            }),
            network: Some(vec![NetworkInterface {
                iface: "eth0".to_string(),
                rx_bytes: 1_000_000,
                tx_bytes: 500_000,
            }]),
            processes: Some(ProcessSnapshot {
                top_cpu: vec![ProcessEntry {
                    pid: 123,
                    name: "cc-agent".to_string(),
                    cpu_percent: 80.0,
                    ram_percent: 5.0,
                }],
                top_ram: vec![ProcessEntry {
                    pid: 456,
                    name: "chrome".to_string(),
                    cpu_percent: 10.0,
                    ram_percent: 40.0,
                }],
            }),
            collected_at: Some(collected),
        };

        let proto_health: proto::MachineHealth = (&health).into();
        let restored: MachineHealth = proto_health.into();

        // Hostname preserved exactly (no longer lost in flat conversion).
        assert_eq!(restored.hostname, "test-host");
        assert_eq!(restored.uptime_seconds, health.uptime_seconds);

        // CPU: exact values preserved (no GB conversion loss).
        assert!((restored.cpu.overall_percent - health.cpu.overall_percent).abs() < 0.01);
        assert_eq!(restored.cpu.per_core_percent, vec![40.0, 51.0]);
        assert!((restored.cpu.load_average[0] - 1.0).abs() < 0.01);
        assert!((restored.cpu.load_average[1] - 2.0).abs() < 0.01);
        assert!((restored.cpu.load_average[2] - 3.0).abs() < 0.01);

        // RAM: exact bytes preserved (no GB conversion loss).
        assert_eq!(restored.ram.total_bytes, health.ram.total_bytes);
        assert_eq!(restored.ram.used_bytes, health.ram.used_bytes);
        assert!((restored.ram.percent - 50.0).abs() < 0.01);

        // Disk: all mounts preserved individually.
        assert_eq!(restored.disk.len(), 1);
        assert_eq!(restored.disk[0].mount, "/");
        assert_eq!(restored.disk[0].total_bytes, 536_870_912_000);
        assert_eq!(restored.disk[0].used_bytes, 107_374_182_400);

        // Docker
        assert!(restored.docker.is_some());
        let docker = restored.docker.unwrap();
        assert_eq!(docker.containers, 2);
        assert_eq!(docker.running, 1);

        // Network
        assert!(restored.network.is_some());
        let net = restored.network.unwrap();
        assert_eq!(net.len(), 1);
        assert_eq!(net[0].iface, "eth0");
        assert_eq!(net[0].rx_bytes, 1_000_000);
        assert_eq!(net[0].tx_bytes, 500_000);

        // Processes
        assert!(restored.processes.is_some());
        let procs = restored.processes.unwrap();
        assert_eq!(procs.top_cpu.len(), 1);
        assert_eq!(procs.top_cpu[0].name, "cc-agent");
        assert_eq!(procs.top_ram.len(), 1);
        assert_eq!(procs.top_ram[0].name, "chrome");

        // collected_at
        assert!(restored.collected_at.is_some());
        let diff = (restored.collected_at.unwrap() - collected)
            .num_milliseconds()
            .unsigned_abs();
        assert!(diff < 1000, "collected_at round-trip within 1s, got {}ms", diff);
    }

    #[test]
    fn machine_health_load_avg_padding() {
        // Proto with fewer than 3 load_average values should pad with zeros.
        let proto_health = proto::MachineHealth {
            hostname: String::new(),
            uptime_seconds: 3600,
            cpu: Some(proto::CpuInfo {
                overall_percent: 10.0,
                per_core_percent: vec![],
                load_average: vec![1.5],
            }),
            ram: Some(proto::RamInfo {
                total_bytes: 8_589_934_592,
                used_bytes: 4_294_967_296,
                percent: 50.0,
            }),
            disk: vec![],
            docker: None,
            docker_containers: vec![],
            collected_at: None,
            network: vec![],
            processes: None,
        };

        let restored: MachineHealth = proto_health.into();
        assert_eq!(restored.cpu.load_average, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn machine_health_empty_optional_fields() {
        let health = MachineHealth::default();

        let proto_health: proto::MachineHealth = (&health).into();
        let restored: MachineHealth = proto_health.into();

        assert!(restored.network.is_none());
        assert!(restored.processes.is_none());
        assert!(restored.collected_at.is_none());
        assert!(restored.docker.is_none());
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
            SessionStatus::Ended,
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
