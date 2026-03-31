use std::sync::Arc;

use nexus_core::project_registry::ProjectRegistry;
use nexus_core::proto::{self, nexus_agent_server::NexusAgent};
use tonic::{Request, Response, Status};

use crate::events::EventBroadcaster;
use crate::health::HealthCollector;
use crate::registry::SessionRegistry;
use crate::services::command_registry::CommandRegistry;
use crate::services::project_status::ProjectStatusCache;
use crate::services::session_pool::SessionPool;
use crate::shutdown::ShutdownCoordinator;

pub mod commands;
pub mod sessions;
pub mod status;

/// gRPC service implementation for the NexusAgent service.
pub struct NexusAgentService {
    pub(super) registry: Arc<SessionRegistry>,
    pub(super) events: Arc<EventBroadcaster>,
    pub(super) health: HealthCollector,
    pub(super) agent_name: String,
    pub(super) agent_host: String,
    pub(super) started_at: std::time::Instant,
    pub(super) shutdown: Arc<ShutdownCoordinator>,
    pub(super) project_registry: ProjectRegistry,
    pub(super) status_cache: ProjectStatusCache,
    pub(super) session_pool: SessionPool,
    pub(super) command_registry: CommandRegistry,
}

impl NexusAgentService {
    pub fn new(
        registry: Arc<SessionRegistry>,
        events: Arc<EventBroadcaster>,
        health: HealthCollector,
        agent_name: String,
        agent_host: String,
        shutdown: Arc<ShutdownCoordinator>,
        project_registry: ProjectRegistry,
        status_cache: ProjectStatusCache,
        session_pool: SessionPool,
        command_registry: CommandRegistry,
    ) -> Self {
        Self {
            registry,
            events,
            health,
            agent_name,
            agent_host,
            started_at: std::time::Instant::now(),
            shutdown,
            project_registry,
            status_cache,
            session_pool,
            command_registry,
        }
    }
}

// ---------------------------------------------------------------------------
// Conversion: nexus_core::session types -> proto types
// ---------------------------------------------------------------------------

pub fn session_status_to_proto(status: &nexus_core::session::SessionStatus) -> i32 {
    match status {
        nexus_core::session::SessionStatus::Active => proto::SessionStatus::Active.into(),
        nexus_core::session::SessionStatus::Idle => proto::SessionStatus::Idle.into(),
        nexus_core::session::SessionStatus::Stale => proto::SessionStatus::Stale.into(),
        nexus_core::session::SessionStatus::Errored => proto::SessionStatus::Errored.into(),
    }
}

pub fn datetime_to_timestamp(dt: &chrono::DateTime<chrono::Utc>) -> Option<prost_types::Timestamp> {
    Some(prost_types::Timestamp {
        seconds: dt.timestamp(),
        nanos: dt.timestamp_subsec_nanos() as i32,
    })
}

pub fn session_to_proto(session: &nexus_core::session::Session) -> proto::Session {
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
            total_cost_usd: session.total_cost_usd.map(|c| c as f32),
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
        session_type: proto::SessionType::AdHoc.into(),
        spec: session.spec.clone(),
        command: session.command.clone(),
        agent: session.agent.clone(),
        tmux_session: session.tmux_session.clone(),
        cc_session_id: session.cc_session_id.clone(),
        telemetry,
    }
}

pub(super) fn command_info_to_proto(
    info: &nexus_core::command::CommandInfo,
) -> proto::CommandInfoProto {
    proto::CommandInfoProto {
        name: info.name.clone(),
        namespace: info.namespace.clone(),
        full_name: info.full_name.clone(),
        description: info.description.clone(),
        tier: match info.tier {
            nexus_core::command::CommandTier::Status => proto::CommandTier::Status.into(),
            nexus_core::command::CommandTier::Analysis => proto::CommandTier::Analysis.into(),
            nexus_core::command::CommandTier::Action => proto::CommandTier::Action.into(),
        },
        cost: match info.cost {
            nexus_core::command::CostCategory::Minimal => proto::CostCategory::Minimal.into(),
            nexus_core::command::CostCategory::Low => proto::CostCategory::Low.into(),
            nexus_core::command::CostCategory::Medium => proto::CostCategory::Medium.into(),
            nexus_core::command::CostCategory::High => proto::CostCategory::High.into(),
        },
    }
}

/// Check whether a session matches the given filter criteria.
pub(super) fn matches_filter(session: &proto::Session, filter: &proto::SessionFilter) -> bool {
    if let Some(status) = filter.status {
        if session.status != status {
            return false;
        }
    }
    if let Some(ref project) = filter.project {
        match &session.project {
            Some(p) if p == project => {}
            _ => return false,
        }
    }
    if let Some(session_type) = filter.session_type {
        if session.session_type != session_type {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// NexusAgent trait implementation — delegates to submodule handle_* methods
// ---------------------------------------------------------------------------

#[tonic::async_trait]
impl NexusAgent for NexusAgentService {
    async fn get_sessions(
        &self,
        request: Request<proto::SessionFilter>,
    ) -> Result<Response<proto::SessionList>, Status> {
        self.handle_get_sessions(request).await
    }

    async fn get_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::Session>, Status> {
        self.handle_get_session(request).await
    }

    async fn start_session(
        &self,
        request: Request<proto::StartSessionRequest>,
    ) -> Result<Response<proto::StartSessionResponse>, Status> {
        self.handle_start_session(request).await
    }

    async fn stop_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::StopResult>, Status> {
        self.handle_stop_session(request).await
    }

    async fn register_session(
        &self,
        request: Request<proto::RegisterSessionRequest>,
    ) -> Result<Response<proto::RegisterSessionResponse>, Status> {
        self.handle_register_session(request).await
    }

    async fn unregister_session(
        &self,
        request: Request<proto::UnregisterSessionRequest>,
    ) -> Result<Response<proto::UnregisterSessionResponse>, Status> {
        self.handle_unregister_session(request).await
    }

    async fn heartbeat(
        &self,
        request: Request<proto::HeartbeatRequest>,
    ) -> Result<Response<proto::HeartbeatResponse>, Status> {
        self.handle_heartbeat(request).await
    }

    type SendCommandStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::CommandOutput, Status>>;

    async fn send_command(
        &self,
        request: Request<proto::CommandRequest>,
    ) -> Result<Response<Self::SendCommandStream>, Status> {
        self.handle_send_command(request).await
    }

    type RunProjectCommandStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::CommandOutput, Status>>;

    async fn run_project_command(
        &self,
        request: Request<proto::RunProjectCommandRequest>,
    ) -> Result<Response<Self::RunProjectCommandStream>, Status> {
        self.handle_run_project_command(request).await
    }

    async fn get_project_status(
        &self,
        request: Request<proto::ProjectStatusRequest>,
    ) -> Result<Response<proto::ProjectStatusResponse>, Status> {
        self.handle_get_project_status(request).await
    }

    async fn list_commands(
        &self,
        request: Request<proto::ListCommandsRequest>,
    ) -> Result<Response<proto::ListCommandsResponse>, Status> {
        self.handle_list_commands(request).await
    }

    async fn get_health(
        &self,
        request: Request<proto::HealthRequest>,
    ) -> Result<Response<proto::HealthResponse>, Status> {
        self.handle_get_health(request).await
    }

    async fn list_projects(
        &self,
        request: Request<proto::ListProjectsRequest>,
    ) -> Result<Response<proto::ListProjectsResponse>, Status> {
        self.handle_list_projects(request).await
    }

    async fn list_agents(
        &self,
        request: Request<proto::ListAgentsRequest>,
    ) -> Result<Response<proto::ListAgentsResponse>, Status> {
        self.handle_list_agents(request).await
    }

    type StreamEventsStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::SessionEvent, Status>>;

    async fn stream_events(
        &self,
        request: Request<proto::EventFilter>,
    ) -> Result<Response<Self::StreamEventsStream>, Status> {
        self.handle_stream_events(request).await
    }
}
