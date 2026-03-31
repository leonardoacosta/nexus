use std::sync::Arc;

use nexus_core::proto;
use nexus_core::session::Session;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::services::session_pool::PooledSessionStatus;

use super::NexusAgentService;

pub(super) type SendCommandStream =
    tokio_stream::wrappers::ReceiverStream<Result<proto::CommandOutput, Status>>;

pub(super) type RunProjectCommandStream =
    tokio_stream::wrappers::ReceiverStream<Result<proto::CommandOutput, Status>>;

impl NexusAgentService {
    pub(super) async fn handle_send_command(
        &self,
        request: Request<proto::CommandRequest>,
    ) -> Result<Response<SendCommandStream>, Status> {
        let req = request.into_inner();

        // ---------------------------------------------------------------------------
        // Project routing: when `project` is set and `session_id` is empty, route
        // through the session pool instead of looking up a specific session.
        // ---------------------------------------------------------------------------
        if let Some(ref project_code) = req.project {
            if req.session_id.is_empty() {
                return self.send_command_via_pool(project_code.clone(), req).await;
            }
        }

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

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<proto::CommandOutput, Status>>(64);

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
            let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

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

                        if let Some(event) = crate::parser::parse_stream_json_line(&sid, &line) {
                            match event {
                                crate::parser::ParsedEvent::Telemetry(telemetry) => {
                                    // Side-channel telemetry — persist but don't forward on stream.
                                    registry.update_telemetry(&sid, &telemetry).await;
                                }
                                crate::parser::ParsedEvent::Command(output) => {
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
                                crate::parser::ParsedEvent::CommandBatch(outputs) => {
                                    for output in outputs {
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
                                crate::parser::ParsedEvent::CommandBatchWithTelemetry(
                                    outputs,
                                    telemetry,
                                ) => {
                                    registry.update_telemetry(&sid, &telemetry).await;

                                    for output in outputs {
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

    pub(super) async fn handle_run_project_command(
        &self,
        request: Request<proto::RunProjectCommandRequest>,
    ) -> Result<Response<RunProjectCommandStream>, Status> {
        let req = request.into_inner();

        // Validate project exists.
        self.project_registry
            .resolve(&req.project)
            .ok_or_else(|| Status::not_found(format!("project not found: {}", req.project)))?;

        // Validate command exists in registry.
        self.command_registry
            .get(&req.command)
            .await
            .ok_or_else(|| Status::not_found(format!("command not found: {}", req.command)))?;

        // Construct prompt: /<command> <args joined by space>
        let prompt = if req.args.is_empty() {
            format!("/{}", req.command)
        } else {
            format!("/{} {}", req.command, req.args.join(" "))
        };

        // Delegate to send_command_via_pool with the constructed prompt.
        let pool_req = proto::CommandRequest {
            session_id: String::new(),
            prompt,
            project: Some(req.project),
        };

        self.send_command_via_pool(
            pool_req.project.clone().unwrap_or_default(),
            pool_req,
        )
        .await
        .map(|resp| {
            // The inner stream type is the same; wrap as RunProjectCommandStream.
            let stream = resp.into_inner();
            Response::new(stream)
        })
    }

    /// Execute a command routed via the session pool for a given project code.
    ///
    /// Called from `handle_send_command` when `project` is set and `session_id` is
    /// empty. Resolves the project, acquires (or creates) a pooled session,
    /// spawns the command, and releases the session back to the pool when done.
    pub(super) async fn send_command_via_pool(
        &self,
        project_code: String,
        req: proto::CommandRequest,
    ) -> Result<Response<SendCommandStream>, Status> {
        // Resolve the project's cwd from the registry.
        let project = self
            .project_registry
            .resolve(&project_code)
            .ok_or_else(|| Status::not_found(format!("project not found: {project_code}")))?;

        let cwd = project.cwd.to_string_lossy().into_owned();

        // Acquire a session from the pool (creates a Warming placeholder if none exists).
        let pool_session_id = self
            .session_pool
            .get_or_create(&project_code)
            .await
            .map_err(|e| Status::unavailable(e.to_string()))?;

        // Check if this is a brand-new (Warming) session — need to create a real CC session.
        // Peek at the pool status to decide.
        let pool_sessions = self.session_pool.all_sessions().await;
        let is_warming = pool_sessions
            .iter()
            .find(|(code, _)| code == &project_code)
            .map(|(_, status)| *status == PooledSessionStatus::Warming)
            .unwrap_or(false);

        // The real session ID to use for the --session-id / --resume flag.
        let real_session_id = if is_warming {
            // Spawn a new CC session for this project (ad-hoc style: fresh --session-id).
            let new_id = Uuid::new_v4().to_string();

            tracing::info!(
                project = %project_code,
                session_id = %new_id,
                cwd = %cwd,
                "send_command_via_pool: warming — registering new pooled session"
            );

            // Register the session in the registry so it's visible to the TUI.
            let mut session = Session::new(0, cwd.clone());
            session.id = new_id.clone();
            session.cc_session_id = Some(new_id.clone());
            session.project = Some(project_code.clone());
            self.registry.register_managed(session).await;

            // Update the pool entry with the real session ID.
            self.session_pool
                .set_session_id(&project_code, new_id.clone())
                .await;

            new_id
        } else {
            // Existing ready session — use the pool's tracked session ID.
            pool_session_id
        };

        tracing::info!(
            project = %project_code,
            session_id = %real_session_id,
            cwd = %cwd,
            prompt = %req.prompt,
            "send_command_via_pool: executing command"
        );

        let (tx, rx) = tokio::sync::mpsc::channel::<Result<proto::CommandOutput, Status>>(64);

        let sid = real_session_id.clone();
        let registry = Arc::clone(&self.registry);
        let pool = self.session_pool.clone();
        let pc = project_code.clone();

        tokio::spawn(async move {
            // Pool sessions always use --session-id (managed, resumable conversation).
            let mut cmd = tokio::process::Command::new("claude");
            cmd.env("NEXUS_SUBPROCESS", "1");
            cmd.arg("-p")
                .arg("--output-format")
                .arg("stream-json")
                .arg("--verbose")
                .arg("--include-partial-messages")
                .arg("--dangerously-skip-permissions")
                .arg("--resume")
                .arg(&sid)
                .arg(&req.prompt)
                .current_dir(&cwd)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let child = cmd.spawn();
            let mut child = match child {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!("failed to spawn claude process: {e}");
                    tracing::error!(session_id = %sid, project = %pc, "{}", msg);
                    let _ = tx
                        .send(Ok(proto::CommandOutput {
                            session_id: sid.clone(),
                            content: Some(proto::command_output::Content::Error(
                                proto::CommandError {
                                    message: msg,
                                    exit_code: -1,
                                },
                            )),
                        }))
                        .await;
                    pool.release(&pc).await;
                    return;
                }
            };

            let stdout = child.stdout.take().expect("stdout was piped");
            let stderr = child.stderr.take().expect("stderr was piped");
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = tokio::io::AsyncBufReadExt::lines(reader);

            let stderr_handle = tokio::spawn(async move {
                let mut stderr_reader = tokio::io::BufReader::new(stderr);
                let mut stderr_buf = String::new();
                let _ = tokio::io::AsyncReadExt::read_to_string(
                    &mut stderr_reader,
                    &mut stderr_buf,
                )
                .await;
                stderr_buf
            });

            let mut done_sent = false;

            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.trim().is_empty() {
                            continue;
                        }
                        tracing::info!(
                            session_id = %sid,
                            project = %pc,
                            "pool stream-json line: {}",
                            &line[..line.len().min(200)]
                        );

                        if let Some(event) = crate::parser::parse_stream_json_line(&sid, &line) {
                            match event {
                                crate::parser::ParsedEvent::Telemetry(telemetry) => {
                                    registry.update_telemetry(&sid, &telemetry).await;
                                }
                                crate::parser::ParsedEvent::Command(output) => {
                                    if matches!(
                                        &output.content,
                                        Some(proto::command_output::Content::Done(_))
                                    ) {
                                        done_sent = true;
                                    }
                                    if tx.send(Ok(output)).await.is_err() {
                                        tracing::debug!(
                                            session_id = %sid,
                                            "pool send_command: client disconnected"
                                        );
                                        let _ = child.kill().await;
                                        pool.release(&pc).await;
                                        return;
                                    }
                                }
                                crate::parser::ParsedEvent::CommandBatch(outputs) => {
                                    for output in outputs {
                                        if matches!(
                                            &output.content,
                                            Some(proto::command_output::Content::Done(_))
                                        ) {
                                            done_sent = true;
                                        }
                                        if tx.send(Ok(output)).await.is_err() {
                                            tracing::debug!(
                                                session_id = %sid,
                                                "pool send_command: client disconnected"
                                            );
                                            let _ = child.kill().await;
                                            pool.release(&pc).await;
                                            return;
                                        }
                                    }
                                }
                                crate::parser::ParsedEvent::CommandBatchWithTelemetry(
                                    outputs,
                                    telemetry,
                                ) => {
                                    registry.update_telemetry(&sid, &telemetry).await;
                                    for output in outputs {
                                        if matches!(
                                            &output.content,
                                            Some(proto::command_output::Content::Done(_))
                                        ) {
                                            done_sent = true;
                                        }
                                        if tx.send(Ok(output)).await.is_err() {
                                            tracing::debug!(
                                                session_id = %sid,
                                                "pool send_command: client disconnected"
                                            );
                                            let _ = child.kill().await;
                                            pool.release(&pc).await;
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(
                            session_id = %sid,
                            "pool send_command: error reading stdout: {e}"
                        );
                        break;
                    }
                }
            }

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
                        tracing::warn!(session_id = %sid, project = %pc, "{}", msg);
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
                        project = %pc,
                        exit_code = status.code().unwrap_or(-1),
                        "pool send_command: claude process finished"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        session_id = %sid,
                        project = %pc,
                        "pool send_command: failed to wait on claude process: {e}"
                    );
                    let _ = tx
                        .send(Ok(proto::CommandOutput {
                            session_id: sid.clone(),
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

            // Release the pool session back to Ready regardless of success/failure.
            pool.release(&pc).await;
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }
}
