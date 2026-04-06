use std::time::Duration;

use nexus_core::proto;
use nexus_core::session::Session;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use super::NexusAgentService;

/// Poll for process death after SIGKILL. Returns `true` if the process exited
/// within `timeout_ms`, `false` if it was still alive at timeout.
///
/// On Linux, polls `/proc/{pid}` at 50 ms intervals.
/// On other platforms, falls back to a fixed 500 ms sleep.
#[cfg(target_os = "linux")]
async fn wait_for_death(pid: u32, timeout_ms: u64) -> bool {
    let path = format!("/proc/{pid}");
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline {
        if !std::path::Path::new(&path).exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[cfg(not(target_os = "linux"))]
async fn wait_for_death(_pid: u32, _timeout_ms: u64) -> bool {
    tokio::time::sleep(Duration::from_millis(500)).await;
    true
}

impl NexusAgentService {
    #[tracing::instrument(name = "session.get_all", skip(self, request))]
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

    #[tracing::instrument(name = "session.get", skip(self, request), fields(session_id))]
    pub(super) async fn handle_get_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::Session>, Status> {
        let session_id = request.into_inner().id;
        tracing::Span::current().record("session_id", session_id.as_str());

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

    #[tracing::instrument(name = "session.start", skip(self, request))]
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

        // Dedup guard: if an active or idle session already exists for this cwd, return it.
        // Stale, Errored, and Ended sessions are excluded — they should not block a new session.
        {
            let all_sessions = self.registry.get_all().await;
            if let Some(existing) = all_sessions
                .iter()
                .find(|s| s.cwd == cwd && matches!(s.status, nexus_core::session::SessionStatus::Active | nexus_core::session::SessionStatus::Idle))
            {
                tracing::info!(
                    existing_session_id = %existing.id,
                    cwd = %cwd,
                    "dedup: returning existing non-ended session for cwd"
                );
                return Ok(Response::new(proto::StartSessionResponse {
                    session_id: existing.id.clone(),
                    tmux_session: existing.tmux_session.clone().unwrap_or_default(),
                    session_type: proto::SessionType::Managed.into(),
                }));
            }
        }

        // Build the session record.
        let mut session = Session::new(0, cwd.clone());
        session.id = session_id.clone();
        session.cc_session_id = Some(session_id.clone());
        session.project = if req.project.is_empty() {
            None
        } else {
            Some(req.project)
        };
        session.tmux_session = None;

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

                // Register only after successful bootstrap.
                self.registry.register_managed(session).await;
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                tracing::warn!(
                    session_id = %session_id,
                    exit_code = output.status.code().unwrap_or(-1),
                    stderr = %stderr,
                    stdout = %stdout,
                    "bootstrap prompt failed — session not registered"
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
                return Err(Status::internal(format!(
                    "bootstrap prompt failed with exit code {}",
                    output.status.code().unwrap_or(-1)
                )));
            }
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "failed to spawn bootstrap prompt — session not registered"
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
                return Err(Status::internal(e.to_string()));
            }
        }

        Ok(Response::new(proto::StartSessionResponse {
            session_id,
            tmux_session: String::new(),
            session_type: proto::SessionType::Managed.into(),
        }))
    }

    #[tracing::instrument(name = "session.stop", skip(self, request), fields(session_id))]
    pub(super) async fn handle_stop_session(
        &self,
        request: Request<proto::SessionId>,
    ) -> Result<Response<proto::StopResult>, Status> {
        let session_id = request.into_inner().id;
        tracing::Span::current().record("session_id", session_id.as_str());

        let session = self.registry.get_by_id(&session_id).await.ok_or_else(|| {
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
            // Poll for process death (up to 2 seconds) before removing from registry.
            let died = wait_for_death(pid, 2000).await;
            if !died {
                tracing::warn!(
                    "pid {} did not confirm death within 2s after SIGKILL — removing from registry anyway",
                    pid
                );
            }
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

    #[tracing::instrument(name = "session.register", skip(self, request))]
    pub(super) async fn handle_register_session(
        &self,
        request: Request<proto::RegisterSessionRequest>,
    ) -> Result<Response<proto::RegisterSessionResponse>, Status> {
        let req = request.into_inner();

        // Upfront validation guards.
        if req.pid == 0 {
            return Err(Status::invalid_argument("pid must be non-zero"));
        }
        if req.cwd.is_empty() {
            return Err(Status::invalid_argument("cwd must not be empty"));
        }
        if req.session_id.is_empty() {
            return Err(Status::invalid_argument("session_id must not be empty"));
        }

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

    #[tracing::instrument(name = "session.unregister", skip(self, request))]
    pub(super) async fn handle_unregister_session(
        &self,
        request: Request<proto::UnregisterSessionRequest>,
    ) -> Result<Response<proto::UnregisterSessionResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.unregister(&session_id).await;

        Ok(Response::new(proto::UnregisterSessionResponse { found }))
    }

    #[tracing::instrument(name = "session.heartbeat", skip(self, request))]
    pub(super) async fn handle_heartbeat(
        &self,
        request: Request<proto::HeartbeatRequest>,
    ) -> Result<Response<proto::HeartbeatResponse>, Status> {
        let session_id = request.into_inner().session_id;
        let found = self.registry.heartbeat(&session_id).await;

        Ok(Response::new(proto::HeartbeatResponse { found }))
    }
}
