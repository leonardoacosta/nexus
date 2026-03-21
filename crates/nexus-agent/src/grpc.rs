use std::sync::Arc;
use std::time::Duration;

use nexus_core::proto::{self, nexus_agent_server::NexusAgent};
use nexus_core::session::Session;
use tokio::sync::mpsc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::events::EventBroadcaster;
use crate::registry::SessionRegistry;

/// gRPC service implementation for the NexusAgent service.
pub struct NexusAgentService {
    registry: Arc<SessionRegistry>,
    events: Arc<EventBroadcaster>,
    agent_name: String,
    agent_host: String,
}

impl NexusAgentService {
    pub fn new(
        registry: Arc<SessionRegistry>,
        events: Arc<EventBroadcaster>,
        agent_name: String,
        agent_host: String,
    ) -> Self {
        Self {
            registry,
            events,
            agent_name,
            agent_host,
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
    }
}

/// Check whether a session matches the given filter criteria.
fn matches_filter(session: &proto::Session, filter: &proto::SessionFilter) -> bool {
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
// NexusAgent trait implementation
// ---------------------------------------------------------------------------

#[tonic::async_trait]
impl NexusAgent for NexusAgentService {
    async fn get_sessions(
        &self,
        request: Request<proto::SessionFilter>,
    ) -> Result<Response<proto::SessionList>, Status> {
        let filter = request.into_inner();
        let sessions = self.registry.get_all().await;

        let proto_sessions: Vec<proto::Session> = sessions
            .iter()
            .map(session_to_proto)
            .filter(|s| matches_filter(s, &filter))
            .collect();

        Ok(Response::new(proto::SessionList {
            sessions: proto_sessions,
            agent_name: self.agent_name.clone(),
            agent_host: self.agent_host.clone(),
        }))
    }

    async fn get_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::Session>, Status> {
        let session_id = request.into_inner().id;

        match self.registry.get_by_id(&session_id).await {
            Some(session) => Ok(Response::new(session_to_proto(&session))),
            None => Err(Status::not_found(format!(
                "session not found: {}",
                session_id
            ))),
        }
    }

    async fn start_session(
        &self,
        request: Request<proto::StartSessionRequest>,
    ) -> Result<Response<proto::StartSessionResponse>, Status> {
        let req = request.into_inner();

        // Validate tmux is on PATH.
        let tmux_check = std::process::Command::new("which")
            .arg("tmux")
            .output()
            .map_err(|e| Status::internal(format!("failed to check for tmux: {e}")))?;

        if !tmux_check.status.success() {
            return Err(Status::failed_precondition(
                "tmux is not installed or not on PATH",
            ));
        }

        let session_id = Uuid::new_v4().to_string();
        let short_id = &session_id[..8];
        let tmux_session_name = format!("nx-{short_id}");

        // Build the claude command with any extra args.
        let mut tmux_args = vec![
            "new-session".to_string(),
            "-d".to_string(),
            "-s".to_string(),
            tmux_session_name.clone(),
            "-c".to_string(),
            req.cwd.clone(),
            "--".to_string(),
            "claude".to_string(),
        ];
        for arg in &req.args {
            tmux_args.push(arg.clone());
        }

        tracing::info!(
            "starting managed session {} (tmux: {}, cwd: {})",
            session_id,
            tmux_session_name,
            req.cwd,
        );

        let spawn_result = std::process::Command::new("tmux")
            .args(&tmux_args)
            .status()
            .map_err(|e| Status::internal(format!("failed to spawn tmux session: {e}")))?;

        if !spawn_result.success() {
            return Err(Status::internal(format!(
                "tmux new-session exited with {}",
                spawn_result
            )));
        }

        // Get the PID of the tmux session leader.
        let pid = get_tmux_session_pid(&tmux_session_name).unwrap_or(0);

        // Register the managed session in the registry.
        let mut session = Session::new(pid, req.cwd);
        session.id = session_id.clone();
        session.project = if req.project.is_empty() {
            None
        } else {
            Some(req.project)
        };
        session.tmux_session = Some(tmux_session_name.clone());

        self.registry.register_managed(session).await;

        Ok(Response::new(proto::StartSessionResponse {
            session_id,
            tmux_session: tmux_session_name,
            session_type: proto::SessionType::Managed.into(),
        }))
    }

    type StreamEventsStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::SessionEvent, Status>>;

    async fn stream_events(
        &self,
        request: Request<proto::EventFilter>,
    ) -> Result<Response<Self::StreamEventsStream>, Status> {
        let filter = request.into_inner();
        tracing::info!(
            session_filter = ?filter.session_id,
            "stream_events: new subscriber"
        );
        let mut broadcast_rx = self.events.subscribe();

        // Use an mpsc channel between the broadcast receiver and the gRPC
        // stream to provide backpressure. If the client cannot keep up, the
        // mpsc channel will apply backpressure to the forwarding task rather
        // than losing events from the broadcast channel.
        let (tx, rx) = mpsc::channel::<Result<proto::SessionEvent, Status>>(64);

        tokio::spawn(async move {
            loop {
                match broadcast_rx.recv().await {
                    Ok(event) => {
                        // Apply filter: skip events that don't match the requested session_id.
                        if let Some(ref filter_session_id) = filter.session_id
                            && event.session_id != *filter_session_id
                        {
                            continue;
                        }

                        // If the client has disconnected, the send will fail
                        // and we break out of the loop to clean up.
                        if tx.send(Ok(event)).await.is_err() {
                            tracing::debug!("stream_events client disconnected");
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("stream_events subscriber lagged, skipped {} events", n);
                        // Continue streaming — the subscriber missed some events
                        // and should do a full GetSessions refresh if needed.
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::debug!("stream_events broadcast channel closed");
                        break;
                    }
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    async fn register_session(
        &self,
        request: Request<proto::RegisterSessionRequest>,
    ) -> Result<Response<proto::RegisterSessionResponse>, Status> {
        let req = request.into_inner();

        let mut session = Session::new(req.pid, req.cwd);
        session.id = req.session_id.clone();
        session.project = req.project;
        session.branch = req.branch;
        session.command = req.command;

        let created = self.registry.register_adhoc(session).await;

        Ok(Response::new(proto::RegisterSessionResponse {
            session_id: req.session_id,
            created,
        }))
    }

    async fn unregister_session(
        &self,
        request: Request<proto::UnregisterSessionRequest>,
    ) -> Result<Response<proto::UnregisterSessionResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.unregister(&session_id).await;

        Ok(Response::new(proto::UnregisterSessionResponse { found }))
    }

    async fn heartbeat(
        &self,
        request: Request<proto::HeartbeatRequest>,
    ) -> Result<Response<proto::HeartbeatResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.heartbeat(&session_id).await;

        Ok(Response::new(proto::HeartbeatResponse { found }))
    }

    async fn stop_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::StopResult>, Status> {
        let session_id = request.into_inner().id;

        let session = self
            .registry
            .get_by_id(&session_id)
            .await
            .ok_or_else(|| Status::not_found(format!("session not found: {session_id}")))?;

        let pid = session.pid;
        if pid == 0 {
            return Err(Status::failed_precondition(format!(
                "session {session_id} has no valid PID"
            )));
        }

        tracing::info!("stopping session {} (pid {})", session_id, pid);

        // Send SIGTERM first.
        let term_result = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();

        match term_result {
            Ok(status) if status.success() => {
                tracing::debug!("SIGTERM sent to pid {}", pid);
            }
            Ok(status) => {
                // kill returned non-zero — process may already be gone.
                let msg = format!("SIGTERM failed for pid {} (exit: {})", pid, status);
                tracing::warn!("{}", msg);
                self.registry.remove(&session_id).await;
                return Ok(Response::new(proto::StopResult {
                    success: true,
                    message: Some(msg),
                }));
            }
            Err(e) => {
                return Err(Status::internal(format!(
                    "failed to send SIGTERM to pid {pid}: {e}"
                )));
            }
        }

        // Wait up to 10 seconds for the process to exit.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut exited = false;

        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(250)).await;
            // Check if process is still alive: kill -0 returns error if gone.
            let probe = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .status();
            match probe {
                Ok(s) if !s.success() => {
                    exited = true;
                    break;
                }
                _ => continue,
            }
        }

        if !exited {
            tracing::warn!("pid {} did not exit after SIGTERM, sending SIGKILL", pid);
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
            // Brief wait for SIGKILL to take effect.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        self.registry.remove(&session_id).await;

        let message = if exited {
            format!("session {session_id} stopped with SIGTERM")
        } else {
            format!("session {session_id} stopped with SIGKILL after 10s grace period")
        };

        tracing::info!("{}", message);

        Ok(Response::new(proto::StopResult {
            success: true,
            message: Some(message),
        }))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Get the PID of the first process running inside a tmux session.
fn get_tmux_session_pid(session_name: &str) -> Option<u32> {
    let output = std::process::Command::new("tmux")
        .args(["list-panes", "-s", "-t", session_name, "-F", "#{pane_pid}"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next()?.trim().parse().ok()
}
