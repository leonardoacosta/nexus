use std::sync::Arc;

use nexus_core::proto;
use nexus_core::session::Session;
use tonic::{Request, Response, Status};
use uuid::Uuid;

use crate::command_executor::run_claude_subprocess;
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
        if let Some(ref project_code) = req.project
            && req.session_id.is_empty()
        {
            return self.send_command_via_pool(project_code.clone(), req).await;
        }

        let session_id = req.session_id.clone();

        // 1. Look up the session in the registry and refresh its heartbeat
        //    so stale detection doesn't reap it while a command is executing.
        self.registry.heartbeat(&session_id).await;
        let session = self
            .registry
            .get_by_id(&session_id)
            .await
            .ok_or_else(|| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC SendCommand failed: session not found: {session_id}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::not_found(format!("session not found: {session_id}"))
            })?;

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

            // 4. Build the claude child process command.
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

            cmd.arg(&req.prompt).current_dir(&cwd);

            // 5-7. Delegate stream reading, parsing, and forwarding to the
            // shared executor. No pool release needed for direct-session commands.
            run_claude_subprocess(
                cmd,
                sid,
                registry,
                tx,
                None::<fn() -> std::future::Ready<()>>,
            )
            .await;
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
            .ok_or_else(|| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC RunProjectCommand failed: project not found: {}",
                        req.project
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::not_found(format!("project not found: {}", req.project))
            })?;

        // Validate command exists in registry.
        self.command_registry
            .get(&req.command)
            .await
            .ok_or_else(|| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC RunProjectCommand failed: command not found: {}",
                        req.command
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::not_found(format!("command not found: {}", req.command))
            })?;

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

        self.send_command_via_pool(pool_req.project.clone().unwrap_or_default(), pool_req)
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
            .ok_or_else(|| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC SendCommand (pool) failed: project not found: {project_code}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::not_found(format!("project not found: {project_code}"))
            })?;

        let cwd = project.cwd.to_string_lossy().into_owned();

        // Acquire a session from the pool (creates a Warming placeholder if none exists).
        let pool_session_id = self
            .session_pool
            .get_or_create(&project_code)
            .await
            .map_err(|e| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!(
                        "gRPC SendCommand (pool) failed: session pool unavailable for {project_code}: {e}"
                    )),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::unavailable(e.to_string())
            })?;

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
            // Pool sessions always use --resume (managed, resumable conversation).
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
                .current_dir(&cwd);

            // Release the pool session back to Ready regardless of success/failure.
            run_claude_subprocess(
                cmd,
                sid,
                registry,
                tx,
                Some(move || async move {
                    pool.release(&pc).await;
                }),
            )
            .await;
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }
}
