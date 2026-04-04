use std::time::Duration;

use nexus_core::proto;
use nexus_core::session::Session;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use super::NexusAgentService;

impl NexusAgentService {
    pub(super) async fn handle_get_sessions(
        &self,
        request: Request<proto::SessionFilter>,
    ) -> Result<Response<proto::SessionList>, Status> {
        let filter = request.into_inner();
        let sessions = self.registry.get_all().await;

        let proto_sessions: Vec<proto::Session> = sessions
            .iter()
            .map(super::session_to_proto)
            .filter(|s| super::matches_filter(s, &filter))
            .collect();

        Ok(Response::new(proto::SessionList {
            sessions: proto_sessions,
            agent_name: self.agent_name.clone(),
            agent_host: self.agent_host.clone(),
        }))
    }

    pub(super) async fn handle_get_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::Session>, Status> {
        let session_id = request.into_inner().id;

        match self.registry.get_by_id(&session_id).await {
            Some(session) => Ok(Response::new(super::session_to_proto(&session))),
            None => {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC GetSession failed: session not found: {session_id}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Err(Status::not_found(format!(
                    "session not found: {}",
                    session_id
                )))
            }
        }
    }

    pub(super) async fn handle_start_session(
        &self,
        request: Request<proto::StartSessionRequest>,
    ) -> Result<Response<proto::StartSessionResponse>, Status> {
        let req = request.into_inner();

        // Agent targeting: reject if target doesn't match this agent.
        if let Some(ref target) = req.target_agent
            && target != &self.agent_name
        {
            sentry::add_breadcrumb(sentry::Breadcrumb {
                ty: "error".into(),
                category: Some("grpc.call".into()),
                message: Some(format!(
                    "gRPC StartSession failed: agent '{}' does not match target '{target}'",
                    self.agent_name
                )),
                level: sentry::Level::Error,
                ..Default::default()
            });
            return Err(Status::not_found(format!(
                "Agent '{}' does not match target '{}'",
                self.agent_name, target
            )));
        }

        let session_id = Uuid::new_v4().to_string();

        let project_name = if req.project.is_empty() {
            "unknown".to_string()
        } else {
            req.project.clone()
        };

        tracing::info!(
            session_id = %session_id,
            project = %project_name,
            cwd = %req.cwd,
            "starting managed session (bootstrap prompt)",
        );

        // Expand ~ in cwd to the actual home directory.
        let cwd = if req.cwd.starts_with("~/") {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/{}", home, &req.cwd[2..])
        } else {
            req.cwd.clone()
        };

        // Register the managed session in the registry.
        let mut session = Session::new(0, cwd.clone());
        session.id = session_id.clone();
        session.cc_session_id = Some(session_id.clone());
        session.project = if req.project.is_empty() {
            None
        } else {
            Some(req.project)
        };
        session.tmux_session = None;

        self.registry.register_managed(session).await;

        // Run a bootstrap command to establish the CC conversation.
        let bootstrap_prompt = format!(
            "You are starting a new session in project {project_name}. Acknowledge with: Ready."
        );

        let bootstrap_result = tokio::process::Command::new("claude")
            .arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--session-id")
            .arg(&session_id)
            .arg("--dangerously-skip-permissions")
            .current_dir(&cwd)
            .arg(&bootstrap_prompt)
            .output()
            .await;

        match bootstrap_result {
            Ok(output) if output.status.success() => {
                tracing::info!(
                    session_id = %session_id,
                    "bootstrap prompt completed successfully"
                );
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "info".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC StartSession bootstrap succeeded for session {session_id}"
                    )),
                    level: sentry::Level::Info,
                    ..Default::default()
                });
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                tracing::warn!(
                    session_id = %session_id,
                    exit_code = output.status.code().unwrap_or(-1),
                    stderr = %stderr,
                    stdout = %stdout,
                    "bootstrap prompt failed — session registered but may not be resumable"
                );
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC StartSession bootstrap failed for session {session_id}: exit_code={}",
                        output.status.code().unwrap_or(-1)
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
            }
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "failed to spawn bootstrap prompt — session registered but may not be resumable"
                );
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC StartSession failed to spawn bootstrap for session {session_id}: {e}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
            }
        }

        Ok(Response::new(proto::StartSessionResponse {
            session_id,
            tmux_session: String::new(),
            session_type: proto::SessionType::Managed.into(),
        }))
    }

    pub(super) async fn handle_stop_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::StopResult>, Status> {
        let session_id = request.into_inner().id;

        let session = self
            .registry
            .get_by_id(&session_id)
            .await
            .ok_or_else(|| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC StopSession failed: session not found: {session_id}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::not_found(format!("session not found: {session_id}"))
            })?;

        let pid = session.pid;
        if pid == 0 {
            sentry::add_breadcrumb(sentry::Breadcrumb {
                ty: "error".into(),
                category: Some("grpc.call".into()),
                message: Some(format!(
                    "gRPC StopSession failed: session {session_id} has no valid PID"
                )),
                level: sentry::Level::Error,
                ..Default::default()
            });
            return Err(Status::failed_precondition(format!(
                "session {session_id} has no valid PID"
            )));
        }

        tracing::info!("stopping session {} (pid {})", session_id, pid);

        // Send SIGTERM first.
        let nix_pid = Pid::from_raw(pid as i32);
        match signal::kill(nix_pid, Signal::SIGTERM) {
            Ok(()) => {
                tracing::debug!("SIGTERM sent to pid {}", pid);
            }
            Err(nix::errno::Errno::ESRCH) => {
                // Process already gone.
                let msg = format!("SIGTERM: pid {} already exited", pid);
                tracing::warn!("{}", msg);
                self.registry.remove(&session_id).await;
                return Ok(Response::new(proto::StopResult {
                    success: true,
                    message: Some(msg),
                }));
            }
            Err(e) => {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC StopSession failed: could not send SIGTERM to pid {pid}: {e}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
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
            // Check if process is still alive: signal 0 returns ESRCH if gone.
            match signal::kill(nix_pid, None) {
                Err(nix::errno::Errno::ESRCH) => {
                    exited = true;
                    break;
                }
                _ => continue,
            }
        }

        if !exited {
            tracing::warn!("pid {} did not exit after SIGTERM, sending SIGKILL", pid);
            let _ = signal::kill(nix_pid, Signal::SIGKILL);
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

    pub(super) async fn handle_register_session(
        &self,
        request: Request<proto::RegisterSessionRequest>,
    ) -> Result<Response<proto::RegisterSessionResponse>, Status> {
        let req = request.into_inner();

        let mut session = Session::new(req.pid, req.cwd);
        session.id = req.session_id.clone();
        session.project = req.project;
        session.branch = req.branch;
        session.command = req.command;
        session.cc_session_id = Some(req.session_id.clone());

        // gRPC-originated registrations don't have a tmux_target; the pane is
        // only known at hook time (session_start socket event).
        let created = self.registry.register_adhoc(session, None).await;

        Ok(Response::new(proto::RegisterSessionResponse {
            session_id: req.session_id,
            created,
        }))
    }

    pub(super) async fn handle_unregister_session(
        &self,
        request: Request<proto::UnregisterSessionRequest>,
    ) -> Result<Response<proto::UnregisterSessionResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.unregister(&session_id).await;

        Ok(Response::new(proto::UnregisterSessionResponse { found }))
    }

    pub(super) async fn handle_heartbeat(
        &self,
        request: Request<proto::HeartbeatRequest>,
    ) -> Result<Response<proto::HeartbeatResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.heartbeat(&session_id).await;

        Ok(Response::new(proto::HeartbeatResponse { found }))
    }
}
