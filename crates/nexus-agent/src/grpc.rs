use std::sync::Arc;
use std::time::Duration;

use nexus_core::proto::{self, nexus_agent_server::NexusAgent};
use nexus_core::session::Session;
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::events::EventBroadcaster;
use crate::health::HealthCollector;
use crate::parser;
use crate::registry::SessionRegistry;

/// gRPC service implementation for the NexusAgent service.
pub struct NexusAgentService {
    registry: Arc<SessionRegistry>,
    events: Arc<EventBroadcaster>,
    health: HealthCollector,
    agent_name: String,
    agent_host: String,
}

impl NexusAgentService {
    pub fn new(
        registry: Arc<SessionRegistry>,
        events: Arc<EventBroadcaster>,
        health: HealthCollector,
        agent_name: String,
        agent_host: String,
    ) -> Self {
        Self {
            registry,
            events,
            health,
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
    // Build telemetry sub-message if any telemetry fields are populated.
    let telemetry = if session.rate_limit_utilization.is_some()
        || session.total_cost_usd.is_some()
        || session.model.is_some()
    {
        let rate_limit = session.rate_limit_utilization.map(|util| proto::RateLimitInfo {
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
            }
            Err(e) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %e,
                    "failed to spawn bootstrap prompt — session registered but may not be resumable"
                );
            }
        }

        Ok(Response::new(proto::StartSessionResponse {
            session_id,
            tmux_session: String::new(),
            session_type: proto::SessionType::Managed.into(),
        }))
    }

    type SendCommandStream =
        tokio_stream::wrappers::ReceiverStream<Result<proto::CommandOutput, Status>>;

    async fn send_command(
        &self,
        request: Request<proto::CommandRequest>,
    ) -> Result<Response<Self::SendCommandStream>, Status> {
        let req = request.into_inner();
        let session_id = req.session_id.clone();

        // 1. Look up the session in the registry and refresh its heartbeat
        //    so stale detection doesn't reap it while a command is executing.
        self.registry.heartbeat(&session_id).await;
        let session = self
            .registry
            .get_by_id(&session_id)
            .await
            .ok_or_else(|| Status::not_found(format!("session not found: {session_id}")))?;

        // 2. Determine the CC session ID for --resume.
        let resume_id = session
            .cc_session_id
            .clone()
            .unwrap_or_else(|| session.id.clone());

        // 3. Get the working directory (expand ~ if needed).
        let cwd = if session.cwd.starts_with("~/") {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            format!("{}/{}", home, &session.cwd[2..])
        } else {
            session.cwd.clone()
        };

        let (tx, rx) = mpsc::channel::<Result<proto::CommandOutput, Status>>(64);

        let sid = session_id.clone();
        let registry = Arc::clone(&self.registry);
        tokio::spawn(async move {
            tracing::info!(
                session_id = %sid,
                resume_id = %resume_id,
                cwd = %cwd,
                prompt = %req.prompt,
                "send_command: spawning claude -p --resume {} --output-format stream-json --include-partial-messages --dangerously-skip-permissions \"{}\" (cwd={})",
                resume_id, req.prompt, cwd,
            );

            // 4. Spawn the claude child process.
            // Use --resume for managed sessions (nexus controls the session),
            // --session-id for ad-hoc (start fresh conversation in same project context).
            // Managed sessions are created via StartSession RPC and have
            // a bootstrap conversation we can --resume. Ad-hoc sessions are
            // running CC instances we can't resume — use fresh --session-id.
            // We mark managed sessions by setting pid=0 at creation time.
            let is_managed = session.pid == 0;
            let mut cmd = tokio::process::Command::new("claude");
            // Set NEXUS_SUBPROCESS=1 so our hooks skip registration for this process.
            cmd.env("NEXUS_SUBPROCESS", "1");
            cmd.arg("-p")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose")
                .arg("--include-partial-messages")
                .arg("--dangerously-skip-permissions");

            if is_managed {
                cmd.arg("--resume").arg(&resume_id);
            } else {
                // Ad-hoc: fresh conversation per command in same project dir.
                let new_uuid = Uuid::new_v4().to_string();
                cmd.arg("--session-id").arg(&new_uuid);
            }

            let child = cmd
                .arg(&req.prompt)
                .current_dir(&cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn();

            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("failed to spawn claude process: {e}");
                    tracing::error!(session_id = %sid, "{}", msg);
                    let _ = tx
                        .send(Ok(proto::CommandOutput {
                            session_id: sid,
                            content: Some(proto::command_output::Content::Error(
                                proto::CommandError {
                                    message: msg,
                                    exit_code: -1,
                                },
                            )),
                        }))
                        .await;
                    return;
                }
            };

            // 5. Read stdout line by line, capture stderr for error reporting.
            let stdout = child.stdout.take().expect("stdout was piped");
            let stderr = child.stderr.take().expect("stderr was piped");
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();

            // Spawn stderr reader to capture error output.
            let stderr_handle = tokio::spawn(async move {
                let mut stderr_reader = tokio::io::BufReader::new(stderr);
                let mut stderr_buf = String::new();
                let _ =
                    tokio::io::AsyncReadExt::read_to_string(&mut stderr_reader, &mut stderr_buf)
                        .await;
                stderr_buf
            });

            let mut done_sent = false;

            // 6. Parse each line and forward via the gRPC stream.
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        tracing::info!(session_id = %sid, "stream-json line: {}", &line[..line.len().min(200)]);

                        if let Some(event) = parser::parse_stream_json_line(&sid, &line) {
                            match event {
                                parser::ParsedEvent::Telemetry(telemetry) => {
                                    // Side-channel telemetry — persist but don't forward on stream.
                                    registry.update_telemetry(&sid, &telemetry).await;
                                }
                                parser::ParsedEvent::Command(output) => {
                                    if matches!(
                                        &output.content,
                                        Some(proto::command_output::Content::Done(_))
                                    ) {
                                        done_sent = true;
                                    }

                                    if tx.send(Ok(output)).await.is_err() {
                                        tracing::debug!(
                                            session_id = %sid,
                                            "send_command: client disconnected"
                                        );
                                        let _ = child.kill().await;
                                        return;
                                    }
                                }
                                parser::ParsedEvent::CommandWithTelemetry(output, telemetry) => {
                                    // Persist telemetry, then forward the command output.
                                    registry.update_telemetry(&sid, &telemetry).await;

                                    if matches!(
                                        &output.content,
                                        Some(proto::command_output::Content::Done(_))
                                    ) {
                                        done_sent = true;
                                    }

                                    if tx.send(Ok(output)).await.is_err() {
                                        tracing::debug!(
                                            session_id = %sid,
                                            "send_command: client disconnected"
                                        );
                                        let _ = child.kill().await;
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    Ok(None) => {
                        // EOF — process closed stdout.
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(
                            session_id = %sid,
                            "send_command: error reading stdout: {e}"
                        );
                        break;
                    }
                }
            }

            // 7. Wait for process exit and handle non-zero exit codes.
            match child.wait().await {
                Ok(status) => {
                    if !status.success() {
                        let code = status.code().unwrap_or(-1);
                        let stderr_output = stderr_handle.await.unwrap_or_default();
                        let stderr_preview = if stderr_output.len() > 200 {
                            format!("{}...", &stderr_output[..200])
                        } else {
                            stderr_output
                        };
                        let msg = if stderr_preview.is_empty() {
                            format!("claude process exited with code {code}")
                        } else {
                            format!("claude exited {code}: {}", stderr_preview.trim())
                        };
                        tracing::warn!(session_id = %sid, "{}", msg);
                        let _ = tx
                            .send(Ok(proto::CommandOutput {
                                session_id: sid.clone(),
                                content: Some(proto::command_output::Content::Error(
                                    proto::CommandError {
                                        message: msg,
                                        exit_code: code,
                                    },
                                )),
                            }))
                            .await;
                    }

                    // Send a final CommandDone if the parser didn't emit one.
                    if !done_sent {
                        let _ = tx
                            .send(Ok(proto::CommandOutput {
                                session_id: sid.clone(),
                                content: Some(proto::command_output::Content::Done(
                                    proto::CommandDone {
                                        duration_ms: 0,
                                        tool_calls: 0,
                                    },
                                )),
                            }))
                            .await;
                    }

                    tracing::info!(
                        session_id = %sid,
                        exit_code = status.code().unwrap_or(-1),
                        "send_command: claude process finished"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        session_id = %sid,
                        "send_command: failed to wait on claude process: {e}"
                    );
                    let _ = tx
                        .send(Ok(proto::CommandOutput {
                            session_id: sid,
                            content: Some(proto::command_output::Content::Error(
                                proto::CommandError {
                                    message: format!("failed to wait on process: {e}"),
                                    exit_code: -1,
                                },
                            )),
                        }))
                        .await;
                }
            }
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }

    async fn get_health(
        &self,
        _request: Request<proto::HealthRequest>,
    ) -> Result<Response<proto::HealthResponse>, Status> {
        let machine = self.health.get().await;
        let sessions = self.registry.get_all().await;

        // Find the highest rate limit utilization across all sessions.
        let latest_rate_limit = sessions
            .iter()
            .filter_map(|s| {
                s.rate_limit_utilization.map(|util| proto::RateLimitInfo {
                    utilization_percent: util,
                    rate_limit_type: s
                        .rate_limit_type
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    surpassed_threshold: util >= 0.75,
                })
            })
            .max_by(|a, b| {
                a.utilization_percent
                    .partial_cmp(&b.utilization_percent)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

        let health_response = proto::HealthResponse {
            agent_name: self.agent_name.clone(),
            agent_host: self.agent_host.clone(),
            uptime_seconds: 0, // TODO: pass started_at if needed
            session_count: sessions.len() as u32,
            machine: Some(proto::MachineHealth {
                cpu_percent: machine.cpu_percent,
                memory_used_gb: machine.memory_used_gb,
                memory_total_gb: machine.memory_total_gb,
                disk_used_gb: machine.disk_used_gb,
                disk_total_gb: machine.disk_total_gb,
                load_avg: machine.load_avg.to_vec(),
                uptime_seconds: machine.uptime_seconds,
                docker_containers: machine
                    .docker_containers
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| proto::ContainerStatus {
                        name: c.name,
                        running: c.running,
                    })
                    .collect(),
            }),
            latest_rate_limit,
        };

        Ok(Response::new(health_response))
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
        session.cc_session_id = Some(req.session_id.clone());

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

    async fn list_projects(
        &self,
        _request: Request<proto::ListProjectsRequest>,
    ) -> Result<Response<proto::ListProjectsResponse>, Status> {
        use std::collections::BTreeSet;

        let mut project_names = BTreeSet::new();

        // 1. Scan ~/.claude/projects/ for project directories.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let projects_dir = std::path::PathBuf::from(&home).join(".claude/projects");

        match std::fs::read_dir(&projects_dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();

                    // Skip hidden directories.
                    if name.starts_with('.') {
                        continue;
                    }

                    // Only consider directories.
                    if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                        continue;
                    }

                    // Extract project name: last segment after "-dev-".
                    if let Some(pos) = name.rfind("-dev-") {
                        let project = &name[pos + 5..];
                        if !project.is_empty() {
                            project_names.insert(project.to_string());
                        }
                    } else {
                        // No "-dev-" segment — use directory name as-is.
                        project_names.insert(name);
                    }
                }
            }
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        path = %projects_dir.display(),
                        error = %e,
                        "failed to read projects directory"
                    );
                }
                // Return empty on not-found or permission errors.
            }
        }

        // 2. Also add projects from active sessions (registry).
        let sessions = self.registry.get_all().await;
        for session in &sessions {
            if let Some(ref project) = session.project {
                project_names.insert(project.clone());
            }
        }

        let projects: Vec<String> = project_names.into_iter().collect();

        Ok(Response::new(proto::ListProjectsResponse { projects }))
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
