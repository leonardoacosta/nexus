use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use tonic::transport::{Channel, Endpoint};
use tracing::warn;

use nexus_core::agent::AgentInfo;
use nexus_core::config::{AgentConfig, NexusConfig};
use nexus_core::health::MachineHealth;
use nexus_core::proto::nexus_agent_client::NexusAgentClient;
use nexus_core::proto::{HealthRequest, SessionFilter, SessionId};
use nexus_core::session::{Session, SessionStatus};

/// Connection timeout for each agent.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Request timeout for each RPC call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------
// Connection state types (tasks 2.1, 2.2)
// ---------------------------------------------------------------------------

/// Per-agent connection tracking.
#[derive(Debug, Clone)]
pub struct AgentConnection {
    pub config: AgentConfig,
    pub status: ConnectionStatus,
    pub last_seen: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    client: Option<NexusAgentClient<Channel>>,
}

/// Whether the TUI can currently reach this agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connected,
    Disconnected,
}

// ---------------------------------------------------------------------------
// NexusClient (tasks 3.1 – 3.6, 4.1 – 4.4)
// ---------------------------------------------------------------------------

/// Manages gRPC connections to all configured nexus agents.
pub struct NexusClient {
    pub agents: Vec<AgentConnection>,
}

impl NexusClient {
    /// Create a new client from the loaded configuration.
    ///
    /// Connections are *not* established yet — call [`connect_all`] after construction.
    pub fn new(config: NexusConfig) -> Self {
        let agents = config
            .agents
            .into_iter()
            .map(|cfg| AgentConnection {
                config: cfg,
                status: ConnectionStatus::Disconnected,
                last_seen: None,
                last_error: None,
                client: None,
            })
            .collect();

        Self { agents }
    }

    /// Attempt to connect to every configured agent.
    ///
    /// Agents that are unreachable are marked `Disconnected` with the error
    /// stored in `last_error`. The method never fails — partial connectivity
    /// is expected in a multi-machine setup.
    pub async fn connect_all(&mut self) {
        for agent in &mut self.agents {
            let endpoint = format!("http://{}:{}", agent.config.host, agent.config.port);

            match Endpoint::from_shared(endpoint.clone())
                .map(|ep| ep.connect_timeout(CONNECT_TIMEOUT).timeout(REQUEST_TIMEOUT))
            {
                Ok(ep) => match ep.connect().await {
                    Ok(channel) => {
                        agent.client = Some(NexusAgentClient::new(channel));
                        agent.status = ConnectionStatus::Connected;
                        agent.last_seen = Some(Utc::now());
                        agent.last_error = None;
                    }
                    Err(e) => {
                        warn!(
                            agent = %agent.config.name,
                            endpoint = %endpoint,
                            error = %e,
                            "failed to connect to agent"
                        );
                        agent.status = ConnectionStatus::Disconnected;
                        agent.last_error = Some(e.to_string());
                        agent.client = None;
                    }
                },
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        endpoint = %endpoint,
                        error = %e,
                        "invalid agent endpoint"
                    );
                    agent.status = ConnectionStatus::Disconnected;
                    agent.last_error = Some(e.to_string());
                    agent.client = None;
                }
            }
        }
    }

    /// Query all connected agents for their sessions and aggregate results.
    ///
    /// Unreachable agents contribute an empty session list and are marked
    /// `Disconnected` so the UI can display their status.
    pub async fn get_sessions(&mut self) -> Vec<(AgentInfo, Vec<Session>)> {
        let mut results = Vec::with_capacity(self.agents.len());

        for agent in &mut self.agents {
            let (sessions, connected, health) = match agent.client.as_mut() {
                Some(client) => {
                    let request = tonic::Request::new(SessionFilter {
                        status: None,
                        project: None,
                        session_type: None,
                    });

                    match client.get_sessions(request).await {
                        Ok(response) => {
                            agent.last_seen = Some(Utc::now());
                            agent.status = ConnectionStatus::Connected;
                            agent.last_error = None;

                            let list = response.into_inner();
                            let sessions =
                                list.sessions.into_iter().map(proto_to_session).collect();

                            // Fetch health data from the same agent.
                            let health = match client
                                .get_health(tonic::Request::new(HealthRequest {}))
                                .await
                            {
                                Ok(resp) => resp.into_inner().machine.map(proto_to_machine_health),
                                Err(e) => {
                                    warn!(
                                        agent = %agent.config.name,
                                        error = %e,
                                        "failed to fetch health"
                                    );
                                    None
                                }
                            };

                            (sessions, true, health)
                        }
                        Err(e) => {
                            warn!(
                                agent = %agent.config.name,
                                error = %e,
                                "failed to list sessions"
                            );
                            agent.status = ConnectionStatus::Disconnected;
                            agent.last_error = Some(e.to_string());
                            (Vec::new(), false, None)
                        }
                    }
                }
                None => (Vec::new(), false, None),
            };

            let info = AgentInfo {
                name: agent.config.name.clone(),
                host: agent.config.host.clone(),
                port: agent.config.port,
                os: String::new(),
                sessions: sessions.clone(),
                health,
                connected,
            };

            results.push((info, sessions));
        }

        results
    }

    /// Look up a single session by ID across all connected agents.
    ///
    /// Returns the owning agent's info together with the session, or `None` if
    /// no connected agent knows about this session.
    #[allow(dead_code)] // Used by spec 8 (detail screen)
    pub async fn get_session(&mut self, id: &str) -> Option<(AgentInfo, Session)> {
        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };

            let request = tonic::Request::new(SessionId { id: id.to_string() });

            match client.get_session(request).await {
                Ok(response) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;

                    let session = proto_to_session(response.into_inner());
                    let info = AgentInfo {
                        name: agent.config.name.clone(),
                        host: agent.config.host.clone(),
                        port: agent.config.port,
                        os: String::new(),
                        sessions: vec![session.clone()],
                        health: None,
                        connected: true,
                    };
                    return Some((info, session));
                }
                Err(e) => {
                    // NOT_FOUND is expected when the session isn't on this agent.
                    if e.code() != tonic::Code::NotFound {
                        warn!(
                            agent = %agent.config.name,
                            session_id = %id,
                            error = %e,
                            "error querying session"
                        );
                        agent.status = ConnectionStatus::Disconnected;
                        agent.last_error = Some(e.to_string());
                    }
                }
            }
        }

        None
    }

    /// Start a new managed session on the specified agent.
    ///
    /// `agent_name` must match a connected agent's config name.  Returns
    /// `Ok(session_id)` on success.
    pub async fn start_session(
        &mut self,
        agent_name: &str,
        project: &str,
        cwd: &str,
    ) -> Result<String> {
        let agent = self
            .agents
            .iter_mut()
            .find(|a| a.config.name == agent_name && a.client.is_some())
            .ok_or_else(|| anyhow::anyhow!("agent {agent_name} not connected"))?;

        let client = agent.client.as_mut().unwrap();
        let request = tonic::Request::new(nexus_core::proto::StartSessionRequest {
            project: project.to_string(),
            cwd: cwd.to_string(),
            args: Vec::new(),
        });

        match client.start_session(request).await {
            Ok(response) => {
                agent.last_seen = Some(Utc::now());
                agent.status = ConnectionStatus::Connected;
                agent.last_error = None;
                Ok(response.into_inner().session_id)
            }
            Err(e) => {
                warn!(
                    agent = %agent.config.name,
                    error = %e,
                    "failed to start session"
                );
                agent.status = ConnectionStatus::Disconnected;
                agent.last_error = Some(e.to_string());
                Err(e.into())
            }
        }
    }

    /// List projects from the specified agent.
    pub async fn list_projects(&mut self, agent_name: &str) -> Result<Vec<String>> {
        let agent = self
            .agents
            .iter_mut()
            .find(|a| a.config.name == agent_name && a.client.is_some())
            .ok_or_else(|| anyhow::anyhow!("agent {agent_name} not connected"))?;

        let client = agent.client.as_mut().unwrap();
        let request = tonic::Request::new(nexus_core::proto::ListProjectsRequest {});

        match client.list_projects(request).await {
            Ok(response) => {
                agent.last_seen = Some(Utc::now());
                agent.status = ConnectionStatus::Connected;
                agent.last_error = None;
                Ok(response.into_inner().projects)
            }
            Err(e) => {
                warn!(
                    agent = %agent.config.name,
                    error = %e,
                    "failed to list projects"
                );
                agent.status = ConnectionStatus::Disconnected;
                agent.last_error = Some(e.to_string());
                Err(e.into())
            }
        }
    }

    /// Send a StopSession RPC to the agent that owns the given session.
    ///
    /// Returns `Ok(true)` if the agent confirmed the stop, `Ok(false)` if the
    /// agent responded but reported failure, and `Err` if no agent owns the
    /// session or the RPC failed.
    #[allow(dead_code)] // Used by spec 8 (detail screen)
    pub async fn stop_session(&mut self, id: &str) -> Result<bool> {
        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };

            let request = tonic::Request::new(SessionId { id: id.to_string() });

            match client.stop_session(request).await {
                Ok(response) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    return Ok(response.into_inner().success);
                }
                Err(e) => {
                    if e.code() == tonic::Code::NotFound {
                        // Not on this agent — try the next one.
                        continue;
                    }
                    warn!(
                        agent = %agent.config.name,
                        session_id = %id,
                        error = %e,
                        "error stopping session"
                    );
                    agent.status = ConnectionStatus::Disconnected;
                    agent.last_error = Some(e.to_string());
                    return Err(e.into());
                }
            }
        }

        anyhow::bail!("session {id} not found on any connected agent")
    }

    /// Send a command to a session via the broker. Returns a streaming receiver
    /// of CommandOutput messages. Tries each connected agent until one owns the session.
    pub async fn send_command(
        &mut self,
        session_id: &str,
        prompt: &str,
    ) -> anyhow::Result<tonic::Streaming<nexus_core::proto::CommandOutput>> {
        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };

            let request = tonic::Request::new(nexus_core::proto::CommandRequest {
                session_id: session_id.to_string(),
                prompt: prompt.to_string(),
            });

            match client.send_command(request).await {
                Ok(response) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    return Ok(response.into_inner());
                }
                Err(e) => {
                    if e.code() == tonic::Code::NotFound {
                        continue; // Try next agent
                    }
                    warn!(
                        agent = %agent.config.name,
                        session_id = %session_id,
                        error = %e,
                        "error sending command"
                    );
                    return Err(e.into());
                }
            }
        }
        anyhow::bail!("session {session_id} not found on any connected agent")
    }
}

// ---------------------------------------------------------------------------
// Proto conversion helpers
// ---------------------------------------------------------------------------

/// Convert a protobuf `Session` message into the core `Session` type.
fn proto_to_session(proto: nexus_core::proto::Session) -> Session {
    let started_at = proto
        .started_at
        .map(proto_timestamp_to_datetime)
        .unwrap_or_else(Utc::now);

    let last_heartbeat = proto
        .last_heartbeat
        .map(proto_timestamp_to_datetime)
        .unwrap_or_else(Utc::now);

    let status = match proto.status {
        1 => SessionStatus::Active,
        2 => SessionStatus::Idle,
        3 => SessionStatus::Stale,
        4 => SessionStatus::Errored,
        _ => SessionStatus::Active,
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
    }
}

/// Convert a protobuf `Timestamp` to a `chrono::DateTime<Utc>`.
fn proto_timestamp_to_datetime(ts: prost_types::Timestamp) -> DateTime<Utc> {
    DateTime::from_timestamp(ts.seconds, ts.nanos as u32).unwrap_or_else(Utc::now)
}

/// Convert a protobuf `MachineHealth` message into the core `MachineHealth` type.
fn proto_to_machine_health(proto: nexus_core::proto::MachineHealth) -> MachineHealth {
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
                .map(|c| nexus_core::health::ContainerStatus {
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
