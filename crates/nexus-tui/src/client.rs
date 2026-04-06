use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use tonic::transport::{Channel, Endpoint};
use tracing::warn;

use nexus_core::agent::AgentSnapshot;
use nexus_core::config::{AgentConfig, NexusConfig};
use nexus_core::health::MachineHealth;
use nexus_core::proto::nexus_agent_client::NexusAgentClient;
use nexus_core::proto::{HealthRequest, SessionFilter, SessionId, SyncStatus as ProtoSyncStatus};
use nexus_core::session::Session;

use crate::app::{ProjectDetail, SyncStatus};

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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connected,
    /// Reconnect attempts are in progress.
    Reconnecting {
        attempt: u32,
    },
    /// Permanently disconnected (e.g. DNS failure). No automatic retries.
    Disconnected {
        reason: String,
    },
}

impl AgentConnection {
    /// Attempt to (re)connect this agent. Updates `status`, `client`, and
    /// `last_seen`/`last_error` on both success and failure.
    pub async fn reconnect(&mut self) -> anyhow::Result<()> {
        let endpoint = format!("http://{}:{}", self.config.host, self.config.port);
        match Endpoint::from_shared(endpoint)?
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .connect()
            .await
        {
            Ok(channel) => {
                self.client = Some(NexusAgentClient::new(channel));
                self.status = ConnectionStatus::Connected;
                self.last_seen = Some(Utc::now());
                self.last_error = None;
                Ok(())
            }
            Err(e) => {
                let reason = e.to_string();
                let is_dns = reason.contains("dns error")
                    || reason.contains("Name or service not known")
                    || reason.contains("No address associated");
                if is_dns {
                    self.status = ConnectionStatus::Disconnected {
                        reason: format!("{}: DNS resolution failed", self.config.host),
                    };
                } else {
                    let attempt = match &self.status {
                        ConnectionStatus::Reconnecting { attempt } => attempt + 1,
                        _ => 1,
                    };
                    self.status = ConnectionStatus::Reconnecting { attempt };
                }
                self.last_error = Some(reason.clone());
                Err(anyhow::anyhow!(reason))
            }
        }
    }
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
                status: ConnectionStatus::Reconnecting { attempt: 0 },
                last_seen: None,
                last_error: None,
                client: None,
            })
            .collect();

        Self { agents }
    }

    /// Update the agent list from a new configuration.
    ///
    /// Agents that already exist (matched by name) keep their connection state.
    /// New agents start as `Reconnecting { attempt: 0 }`.
    /// Removed agents are dropped (connections closed).
    pub fn update_config(&mut self, config: NexusConfig) {
        let mut new_agents: Vec<AgentConnection> = Vec::with_capacity(config.agents.len());
        for cfg in config.agents {
            // Try to find an existing connection for this agent name.
            if let Some(pos) = self.agents.iter().position(|a| a.config.name == cfg.name) {
                let mut existing = self.agents.swap_remove(pos);
                // Update host/port in case they changed.
                existing.config = cfg;
                new_agents.push(existing);
            } else {
                new_agents.push(AgentConnection {
                    config: cfg,
                    status: ConnectionStatus::Reconnecting { attempt: 0 },
                    last_seen: None,
                    last_error: None,
                    client: None,
                });
            }
        }
        self.agents = new_agents;
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
                        let reason = e.to_string();
                        let is_dns = reason.contains("dns error")
                            || reason.contains("Name or service not known")
                            || reason.contains("No address associated");
                        agent.status = if is_dns {
                            ConnectionStatus::Disconnected {
                                reason: format!("{}: DNS resolution failed", agent.config.host),
                            }
                        } else {
                            ConnectionStatus::Reconnecting { attempt: 0 }
                        };
                        agent.last_error = Some(reason);
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
                    agent.status = ConnectionStatus::Disconnected {
                        reason: format!("invalid endpoint: {e}"),
                    };
                    agent.last_error = Some(e.to_string());
                    agent.client = None;
                }
            }
        }
    }

    /// Calculate exponential backoff duration for reconnect attempts.
    ///
    /// Produces: attempt 0→1s, 1→2s, 2→4s, 3→8s, 4+→16s.
    #[cfg(test)]
    pub fn backoff_duration(attempt: u32) -> std::time::Duration {
        let secs = (1u64 << attempt.min(4)).min(30);
        std::time::Duration::from_secs(secs)
    }

    /// Attempt to reconnect all agents that are in `Reconnecting` state.
    ///
    /// Returns the names of agents that successfully reconnected.
    pub async fn reconnect_disconnected(&mut self) -> Vec<String> {
        let mut reconnected = Vec::new();
        for agent in &mut self.agents {
            match &agent.status {
                ConnectionStatus::Connected => continue,
                ConnectionStatus::Disconnected { .. } => continue, // DNS / permanent failures
                ConnectionStatus::Reconnecting { .. } => {
                    if agent.reconnect().await.is_ok() {
                        reconnected.push(agent.config.name.clone());
                    }
                }
            }
        }
        reconnected
    }

    /// Query all connected agents for their sessions and aggregate results.
    ///
    /// Unreachable agents contribute an empty session list and are marked
    /// `Disconnected` so the UI can display their status.
    ///
    /// All agents are queried concurrently via `JoinSet` so the worst-case
    /// latency is bounded by a single agent timeout rather than N * timeout.
    pub async fn get_sessions(&mut self) -> Vec<(AgentSnapshot, Vec<Session>)> {
        use tokio::task::JoinSet;

        // Spawn one task per agent. Agents without a client get a synchronous
        // "no client" result written back directly — no task needed.
        let mut join_set: JoinSet<(usize, AgentQueryResult)> = JoinSet::new();

        for (idx, agent) in self.agents.iter().enumerate() {
            if let Some(client) = agent.client.clone() {
                let name = agent.config.name.clone();
                join_set.spawn(query_single_agent(idx, client, name));
            }
        }

        // Pre-fill results for agents that had no client (disconnected).
        let mut agent_results: Vec<Option<AgentQueryResult>> =
            (0..self.agents.len()).map(|_| None).collect();

        // Collect concurrent results.
        while let Some(join_result) = join_set.join_next().await {
            if let Ok((idx, result)) = join_result {
                agent_results[idx] = Some(result);
            }
        }

        // Write connection status back to self.agents and build return vec.
        let mut results = Vec::with_capacity(self.agents.len());

        for (idx, agent) in self.agents.iter_mut().enumerate() {
            let (sessions, connected, health) = match agent_results[idx].take() {
                Some(AgentQueryResult::Success { sessions, health }) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    (sessions, true, health)
                }
                Some(AgentQueryResult::SessionError { reason }) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %reason,
                        "failed to list sessions"
                    );
                    agent.status = ConnectionStatus::Reconnecting { attempt: 1 };
                    agent.last_error = Some(reason);
                    agent.client = None;
                    (Vec::new(), false, None)
                }
                None => {
                    // No client — already disconnected.
                    (Vec::new(), false, None)
                }
            };

            let info = AgentSnapshot {
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
    pub async fn get_session(&mut self, id: &str) -> Option<(AgentSnapshot, Session)> {
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
                    let info = AgentSnapshot {
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
                        agent.status = ConnectionStatus::Reconnecting { attempt: 1 };
                        agent.last_error = Some(e.to_string());
                        agent.client = None;
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

        // Task 1.4: Use if-let borrow instead of is_some() + unwrap() to avoid panic.
        let client = agent
            .client
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("agent {agent_name} client disappeared"))?;
        let request = tonic::Request::new(nexus_core::proto::StartSessionRequest {
            project: project.to_string(),
            cwd: cwd.to_string(),
            args: Vec::new(),
            target_agent: None,
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
                agent.status = ConnectionStatus::Reconnecting { attempt: 1 };
                agent.last_error = Some(e.to_string());
                agent.client = None;
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

        // Task 1.5: Use if-let borrow instead of is_some() + unwrap() to avoid panic.
        let client = agent
            .client
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("agent {agent_name} client disappeared"))?;
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
                agent.status = ConnectionStatus::Reconnecting { attempt: 1 };
                agent.last_error = Some(e.to_string());
                agent.client = None;
                Err(e.into())
            }
        }
    }

    /// List projects from all connected agents, returning enriched details.
    ///
    /// Merges project names and details across all connected agents.
    /// Returns a map of project name -> `ProjectDetail`.
    pub async fn list_projects_all_enriched(
        &mut self,
    ) -> std::collections::HashMap<String, ProjectDetail> {
        let mut all_details: std::collections::HashMap<String, ProjectDetail> =
            std::collections::HashMap::new();

        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };

            let request = tonic::Request::new(nexus_core::proto::ListProjectsRequest {});
            match client.list_projects(request).await {
                Ok(response) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;

                    let inner = response.into_inner();
                    for info in inner.project_details {
                        let sync_status = match ProtoSyncStatus::try_from(info.sync_status) {
                            Ok(ProtoSyncStatus::Synced) => SyncStatus::Synced,
                            Ok(ProtoSyncStatus::Behind) => SyncStatus::Behind,
                            _ => SyncStatus::Unknown,
                        };
                        all_details.insert(
                            info.name.clone(),
                            ProjectDetail {
                                sync_status,
                                commits_behind: info.commits_behind,
                                git_branch: info.git_branch,
                                path: info.path,
                            },
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %e,
                        "failed to list projects (enriched)"
                    );
                }
            }
        }

        all_details
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
                    agent.status = ConnectionStatus::Reconnecting { attempt: 1 };
                    agent.last_error = Some(e.to_string());
                    agent.client = None;
                    return Err(e.into());
                }
            }
        }

        anyhow::bail!("session {id} not found on any connected agent")
    }

    // -------------------------------------------------------------------------
    // Analytics RPCs (fan-out, sequential)
    // -------------------------------------------------------------------------

    /// Fetch health timeseries from all agents.
    /// Returns `Vec<(agent_name, Vec<HealthTimeSeriesEntry>)>`.
    #[allow(dead_code)] // Wired up by analytics screen tasks
    pub async fn get_health_time_series(
        &mut self,
        hours: u32,
    ) -> Vec<(String, Vec<nexus_core::proto::HealthTimeSeriesEntry>)> {
        let mut results = Vec::new();
        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };
            let request = tonic::Request::new(nexus_core::proto::HealthTimeSeriesRequest { hours });
            match client.get_health_time_series(request).await {
                Ok(resp) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    results.push((agent.config.name.clone(), resp.into_inner().samples));
                }
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %e,
                        "failed to fetch health timeseries"
                    );
                }
            }
        }
        results
    }

    /// Fetch session history from all agents.
    /// Returns merged `Vec<SessionHistoryEntry>` (deduplicated by date — counts
    /// and costs are summed for the same date across agents).
    #[allow(dead_code)] // Wired up by analytics screen tasks
    pub async fn get_session_history(
        &mut self,
        days: u32,
        project: Option<String>,
    ) -> Vec<nexus_core::proto::SessionHistoryEntry> {
        use std::collections::HashMap;

        let mut by_date: HashMap<String, nexus_core::proto::SessionHistoryEntry> = HashMap::new();

        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };
            let request = tonic::Request::new(nexus_core::proto::SessionHistoryRequest {
                days,
                project: project.clone(),
            });
            match client.get_session_history(request).await {
                Ok(resp) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    for entry in resp.into_inner().entries {
                        by_date
                            .entry(entry.date.clone())
                            .and_modify(|existing| {
                                existing.session_count += entry.session_count;
                                existing.total_cost_usd += entry.total_cost_usd;
                            })
                            .or_insert(entry);
                    }
                }
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %e,
                        "failed to fetch session history"
                    );
                }
            }
        }

        let mut entries: Vec<_> = by_date.into_values().collect();
        entries.sort_by(|a, b| a.date.cmp(&b.date));
        entries
    }

    /// Fetch failure trends from all agents.
    /// Returns merged `(daily, by_tool)` — daily entries are summed by date,
    /// by-tool entries are summed by tool name.
    #[allow(dead_code)] // Wired up by analytics screen tasks
    pub async fn get_failure_trends(
        &mut self,
        days: u32,
    ) -> (
        Vec<nexus_core::proto::FailureTrendEntry>,
        Vec<nexus_core::proto::FailureByTool>,
    ) {
        use std::collections::HashMap;

        let mut daily_map: HashMap<String, nexus_core::proto::FailureTrendEntry> = HashMap::new();
        let mut tool_map: HashMap<String, nexus_core::proto::FailureByTool> = HashMap::new();

        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };
            let request = tonic::Request::new(nexus_core::proto::FailureTrendsRequest { days });
            match client.get_failure_trends(request).await {
                Ok(resp) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    let inner = resp.into_inner();
                    for entry in inner.daily {
                        daily_map
                            .entry(entry.date.clone())
                            .and_modify(|existing| {
                                existing.count += entry.count;
                            })
                            .or_insert(entry);
                    }
                    for entry in inner.by_tool {
                        tool_map
                            .entry(entry.tool_name.clone())
                            .and_modify(|existing| {
                                existing.count += entry.count;
                            })
                            .or_insert(entry);
                    }
                }
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %e,
                        "failed to fetch failure trends"
                    );
                }
            }
        }

        let mut daily: Vec<_> = daily_map.into_values().collect();
        daily.sort_by(|a, b| a.date.cmp(&b.date));
        let mut by_tool: Vec<_> = tool_map.into_values().collect();
        by_tool.sort_by(|a, b| b.count.cmp(&a.count));
        (daily, by_tool)
    }

    /// Fetch spec velocity from all agents.
    /// Returns concatenated `Vec<SpecVelocityEntry>` (each agent contributes
    /// its own projects, so entries are concatenated rather than merged).
    #[allow(dead_code)] // Wired up by analytics screen tasks
    pub async fn get_spec_velocity(
        &mut self,
        days: u32,
        project: Option<String>,
    ) -> Vec<nexus_core::proto::SpecVelocityEntry> {
        let mut results = Vec::new();
        for agent in &mut self.agents {
            let client = match agent.client.as_mut() {
                Some(c) => c,
                None => continue,
            };
            let request = tonic::Request::new(nexus_core::proto::SpecVelocityRequest {
                days,
                project: project.clone(),
            });
            match client.get_spec_velocity(request).await {
                Ok(resp) => {
                    agent.last_seen = Some(Utc::now());
                    agent.status = ConnectionStatus::Connected;
                    agent.last_error = None;
                    results.extend(resp.into_inner().entries);
                }
                Err(e) => {
                    warn!(
                        agent = %agent.config.name,
                        error = %e,
                        "failed to fetch spec velocity"
                    );
                }
            }
        }
        results
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
                project: None,
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
// Parallel per-agent query (Spec 3)
// ---------------------------------------------------------------------------

/// Result of querying a single agent for sessions and health.
enum AgentQueryResult {
    Success {
        sessions: Vec<Session>,
        health: Option<MachineHealth>,
    },
    SessionError {
        reason: String,
    },
}

/// Query a single agent for sessions + health. Runs as a standalone async task
/// so all agents can be queried concurrently via `JoinSet`.
async fn query_single_agent(
    idx: usize,
    mut client: NexusAgentClient<Channel>,
    agent_name: String,
) -> (usize, AgentQueryResult) {
    let request = tonic::Request::new(SessionFilter {
        status: None,
        project: None,
        session_type: None,
    });

    let result = match client.get_sessions(request).await {
        Ok(response) => {
            let list = response.into_inner();
            let sessions: Vec<Session> = list.sessions.into_iter().map(proto_to_session).collect();

            // Fetch health data from the same agent.
            let health = match client
                .get_health(tonic::Request::new(HealthRequest {}))
                .await
            {
                Ok(resp) => resp.into_inner().machine.map(proto_to_machine_health),
                Err(e) => {
                    warn!(
                        agent = %agent_name,
                        error = %e,
                        "failed to fetch health"
                    );
                    None
                }
            };

            AgentQueryResult::Success { sessions, health }
        }
        Err(e) => AgentQueryResult::SessionError {
            reason: e.to_string(),
        },
    };

    (idx, result)
}

// ---------------------------------------------------------------------------
// Proto conversion helpers — delegated to nexus_core::proto_convert
// ---------------------------------------------------------------------------

/// Convert a protobuf `Session` message into the core `Session` type.
fn proto_to_session(proto: nexus_core::proto::Session) -> Session {
    proto.into()
}

/// Convert a protobuf `MachineHealth` message into the core `MachineHealth` type.
fn proto_to_machine_health(proto: nexus_core::proto::MachineHealth) -> MachineHealth {
    proto.into()
}

#[cfg(test)]
mod tests {
    use nexus_core::config::{AgentConfig, NexusConfig};

    use super::*;

    fn make_agent_config(name: &str, host: &str) -> AgentConfig {
        AgentConfig {
            name: name.to_string(),
            host: host.to_string(),
            port: nexus_core::DEFAULT_GRPC_PORT,
            user: String::new(),
        }
    }

    fn make_nexus_config(agents: Vec<AgentConfig>) -> NexusConfig {
        NexusConfig {
            agents,
            role: nexus_core::config::AgentRole::Primary,
            self_name: None,
            pool: None,
            bind_address: "127.0.0.1".to_string(),
            secret: None,
        }
    }

    // -------------------------------------------------------------------------
    // NexusClient::new — construction without network I/O
    // -------------------------------------------------------------------------

    #[test]
    fn new_creates_client_with_reconnecting_agents() {
        let cfg = make_nexus_config(vec![
            make_agent_config("machine-a", "192.168.1.10"),
            make_agent_config("machine-b", "192.168.1.11"),
        ]);

        let client = NexusClient::new(cfg);

        assert_eq!(client.agents.len(), 2);
        for agent in &client.agents {
            assert!(
                matches!(agent.status, ConnectionStatus::Reconnecting { .. }),
                "expected Reconnecting, got {:?}",
                agent.status
            );
            assert!(agent.client.is_none());
            assert!(agent.last_seen.is_none());
            assert!(agent.last_error.is_none());
        }
    }

    #[test]
    fn new_empty_config_creates_empty_client() {
        let cfg = make_nexus_config(vec![]);
        let client = NexusClient::new(cfg);
        assert!(client.agents.is_empty());
    }

    #[test]
    fn agent_names_match_config() {
        let cfg = make_nexus_config(vec![
            make_agent_config("nyaptor", "100.64.0.1"),
            make_agent_config("work-mbp", "100.64.0.2"),
        ]);

        let client = NexusClient::new(cfg);
        assert_eq!(client.agents[0].config.name, "nyaptor");
        assert_eq!(client.agents[1].config.name, "work-mbp");
    }

    // -------------------------------------------------------------------------
    // NexusClient::backoff_duration — pure calculation
    // -------------------------------------------------------------------------

    #[test]
    fn backoff_attempt_0_is_1s() {
        assert_eq!(
            NexusClient::backoff_duration(0),
            std::time::Duration::from_secs(1)
        );
    }

    #[test]
    fn backoff_attempt_1_is_2s() {
        assert_eq!(
            NexusClient::backoff_duration(1),
            std::time::Duration::from_secs(2)
        );
    }

    #[test]
    fn backoff_attempt_2_is_4s() {
        assert_eq!(
            NexusClient::backoff_duration(2),
            std::time::Duration::from_secs(4)
        );
    }

    #[test]
    fn backoff_attempt_3_is_8s() {
        assert_eq!(
            NexusClient::backoff_duration(3),
            std::time::Duration::from_secs(8)
        );
    }

    #[test]
    fn backoff_caps_at_16s() {
        // attempt.min(4) means the shift is capped at 4: 1<<4 = 16s maximum.
        assert_eq!(
            NexusClient::backoff_duration(4),
            std::time::Duration::from_secs(16)
        );
        assert_eq!(
            NexusClient::backoff_duration(5),
            std::time::Duration::from_secs(16)
        );
        assert_eq!(
            NexusClient::backoff_duration(100),
            std::time::Duration::from_secs(16)
        );
    }

    // -------------------------------------------------------------------------
    // ConnectionStatus transitions (no network)
    // -------------------------------------------------------------------------

    #[test]
    fn connection_status_equality() {
        assert_eq!(ConnectionStatus::Connected, ConnectionStatus::Connected);
        assert_ne!(
            ConnectionStatus::Connected,
            ConnectionStatus::Reconnecting { attempt: 1 }
        );
        assert_ne!(
            ConnectionStatus::Reconnecting { attempt: 1 },
            ConnectionStatus::Disconnected {
                reason: "dns".into()
            }
        );
    }

    #[test]
    fn disconnected_status_carries_reason() {
        let status = ConnectionStatus::Disconnected {
            reason: "192.168.1.10: DNS resolution failed".to_string(),
        };
        if let ConnectionStatus::Disconnected { reason } = &status {
            assert!(reason.contains("DNS"));
        } else {
            panic!("expected Disconnected");
        }
    }
}
