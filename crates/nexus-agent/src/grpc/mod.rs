use std::sync::Arc;

use nexus_core::db::NexusDb;
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

pub mod analytics;
pub mod commands;
pub mod sessions;
pub mod status;

/// Bundled configuration for constructing a `NexusAgentService`.
pub struct AgentServiceConfig {
    pub registry: Arc<SessionRegistry>,
    pub events: Arc<EventBroadcaster>,
    pub health: HealthCollector,
    pub agent_name: String,
    pub agent_host: String,
    pub shutdown: Arc<ShutdownCoordinator>,
    pub project_registry: ProjectRegistry,
    pub status_cache: ProjectStatusCache,
    pub session_pool: SessionPool,
    pub command_registry: CommandRegistry,
    pub db: Arc<NexusDb>,
}

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
    pub(super) db: Arc<NexusDb>,
}

impl NexusAgentService {
    pub fn new(cfg: AgentServiceConfig) -> Self {
        Self {
            registry: cfg.registry,
            events: cfg.events,
            health: cfg.health,
            agent_name: cfg.agent_name,
            agent_host: cfg.agent_host,
            started_at: std::time::Instant::now(),
            shutdown: cfg.shutdown,
            project_registry: cfg.project_registry,
            status_cache: cfg.status_cache,
            session_pool: cfg.session_pool,
            command_registry: cfg.command_registry,
            db: cfg.db,
        }
    }
}

// ---------------------------------------------------------------------------
// Conversion: re-export from nexus_core::proto_convert
// ---------------------------------------------------------------------------

pub use nexus_core::proto_convert::{datetime_to_timestamp, session_status_to_proto};

/// Convert a domain `Session` to a proto `Session` using the core `From` impl.
pub fn session_to_proto(session: &nexus_core::session::Session) -> proto::Session {
    session.into()
}

/// Convert a domain `CommandInfo` to a proto `CommandInfoProto` using the core `From` impl.
pub(super) fn command_info_to_proto(
    info: &nexus_core::command::CommandInfo,
) -> proto::CommandInfoProto {
    info.into()
}

/// Check whether a session matches the given filter criteria.
pub(super) fn matches_filter(session: &proto::Session, filter: &proto::SessionFilter) -> bool {
    if let Some(status) = filter.status
        && session.status != status
    {
        return false;
    }
    if let Some(ref project) = filter.project {
        match &session.project {
            Some(p) if p == project => {}
            _ => return false,
        }
    }
    if let Some(session_type) = filter.session_type
        && session.session_type != session_type
    {
        return false;
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

    async fn get_session_history(
        &self,
        request: Request<proto::SessionHistoryRequest>,
    ) -> Result<Response<proto::SessionHistoryResponse>, Status> {
        self.handle_get_session_history(request).await
    }

    async fn get_failure_trends(
        &self,
        request: Request<proto::FailureTrendsRequest>,
    ) -> Result<Response<proto::FailureTrendsResponse>, Status> {
        self.handle_get_failure_trends(request).await
    }

    async fn get_health_time_series(
        &self,
        request: Request<proto::HealthTimeSeriesRequest>,
    ) -> Result<Response<proto::HealthTimeSeriesResponse>, Status> {
        self.handle_get_health_time_series(request).await
    }

    async fn get_spec_velocity(
        &self,
        request: Request<proto::SpecVelocityRequest>,
    ) -> Result<Response<proto::SpecVelocityResponse>, Status> {
        self.handle_get_spec_velocity(request).await
    }
}
