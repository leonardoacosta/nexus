use std::collections::BTreeMap;

use nexus_core::proto;
use tonic::{Request, Response, Status};

use super::NexusAgentService;

impl NexusAgentService {
    pub(super) async fn handle_get_health(
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
            uptime_seconds: self.started_at.elapsed().as_secs(),
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

    pub(super) async fn handle_get_project_status(
        &self,
        request: Request<proto::ProjectStatusRequest>,
    ) -> Result<Response<proto::ProjectStatusResponse>, Status> {
        let req = request.into_inner();
        let project_path = self
            .project_registry
            .resolve(&req.project)
            .ok_or_else(|| Status::not_found(format!("unknown project: {}", req.project)))?;

        let status = self
            .status_cache
            .get(&req.project, &project_path.cwd, req.fresh)
            .await;

        Ok(Response::new(proto::ProjectStatusResponse {
            project: req.project,
            beads: Some(proto::BeadsStatus {
                ready_count: status.beads.ready_count,
                open_count: status.beads.open_count,
                blocked_count: status.beads.blocked_count,
                ready_json: status.beads.ready_json,
            }),
            git: Some(proto::GitStatusInfo {
                branch: status.git.branch,
                head_sha: status.git.head_sha,
                recent_commits: status.git.recent_commits,
                porcelain: status.git.porcelain,
            }),
            specs: Some(proto::SpecStatusInfo {
                spec_count: status.spec.spec_count,
                change_count: status.spec.change_count,
                active_changes: status.spec.active_changes,
            }),
        }))
    }

    pub(super) async fn handle_list_commands(
        &self,
        request: Request<proto::ListCommandsRequest>,
    ) -> Result<Response<proto::ListCommandsResponse>, Status> {
        let req = request.into_inner();

        // Convert optional namespace filter.
        let namespace = req.namespace.as_deref();

        // Convert optional proto CommandTier to core CommandTier.
        let tier = req.tier.and_then(|raw| {
            match proto::CommandTier::try_from(raw).unwrap_or(proto::CommandTier::Unspecified) {
                proto::CommandTier::Status => Some(nexus_core::command::CommandTier::Status),
                proto::CommandTier::Analysis => Some(nexus_core::command::CommandTier::Analysis),
                proto::CommandTier::Action => Some(nexus_core::command::CommandTier::Action),
                proto::CommandTier::Unspecified => None,
            }
        });

        let commands = self.command_registry.list(namespace, tier).await;

        let proto_commands: Vec<proto::CommandInfoProto> =
            commands.iter().map(super::command_info_to_proto).collect();

        Ok(Response::new(proto::ListCommandsResponse {
            commands: proto_commands,
        }))
    }

    pub(super) async fn handle_list_projects(
        &self,
        _request: Request<proto::ListProjectsRequest>,
    ) -> Result<Response<proto::ListProjectsResponse>, Status> {
        // project_name -> best known cwd path
        let mut project_map: BTreeMap<String, String> = BTreeMap::new();

        // 1. Scan ~/.claude/projects/ for project directories.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let projects_dir = std::path::PathBuf::from(&home).join(".claude/projects");

        match tokio::fs::read_dir(&projects_dir).await {
            Ok(mut entries) => {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().to_string();

                    // Skip hidden directories.
                    if name.starts_with('.') {
                        continue;
                    }

                    // Only consider directories.
                    if !entry.file_type().await.map(|ft| ft.is_dir()).unwrap_or(false) {
                        continue;
                    }

                    // Extract project name: last segment after "-dev-".
                    if let Some(pos) = name.rfind("-dev-") {
                        let project = &name[pos + 5..];
                        if !project.is_empty() {
                            // Reconstruct the path: replace '-' with '/' for path reconstruction.
                            // Directory encoding replaces '/' with '-', so we reconstruct a best-
                            // effort path from the full directory name.
                            let path_guess = format!("/{}", name.replace('-', "/"));
                            project_map.entry(project.to_string()).or_insert(path_guess);
                        }
                    } else {
                        // No "-dev-" segment — use directory name as-is (no path to guess).
                        project_map.entry(name).or_insert_with(String::new);
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
        // Sessions' cwd is the most reliable path for git operations.
        let sessions = self.registry.get_all().await;
        for session in &sessions {
            if let Some(ref project) = session.project {
                // Prefer cwd from a live session over the guessed path.
                project_map
                    .entry(project.clone())
                    .and_modify(|p| *p = session.cwd.clone())
                    .or_insert_with(|| session.cwd.clone());
            }
        }

        // 3. Build enriched ProjectInfo for each project.
        let mut project_details: Vec<proto::ProjectInfo> = Vec::new();
        for (name, path) in &project_map {
            let info = collect_project_info(name, path).await;
            project_details.push(info);
        }

        let projects: Vec<String> = project_map.into_keys().collect();

        Ok(Response::new(proto::ListProjectsResponse {
            projects,
            project_details,
        }))
    }

    pub(super) async fn handle_list_agents(
        &self,
        _request: Request<proto::ListAgentsRequest>,
    ) -> Result<Response<proto::ListAgentsResponse>, Status> {
        Ok(Response::new(proto::ListAgentsResponse {
            agents: vec![proto::AgentInfo {
                name: self.agent_name.clone(),
                host: self.agent_host.clone(),
                port: 7400,
            }],
        }))
    }

    pub(super) async fn handle_stream_events(
        &self,
        request: Request<proto::EventFilter>,
    ) -> Result<
        Response<tokio_stream::wrappers::ReceiverStream<Result<proto::SessionEvent, Status>>>,
        Status,
    > {
        let filter = request.into_inner();
        tracing::info!(
            session_filter = ?filter.session_id,
            event_types = ?filter.event_types,
            initial_snapshot = filter.initial_snapshot,
            "stream_events: new subscriber"
        );
        let mut broadcast_rx = self.events.subscribe();

        // Use an mpsc channel between the broadcast receiver and the gRPC
        // stream to provide backpressure. If the client cannot keep up, the
        // mpsc channel will apply backpressure to the forwarding task rather
        // than losing events from the broadcast channel.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<proto::SessionEvent, Status>>(64);

        let agent_name = self.agent_name.clone();
        let registry = std::sync::Arc::clone(&self.registry);

        // Convert the repeated i32 event_types to a set of EventType values
        // for efficient lookup. An empty set means "pass all events".
        let allowed_event_types: Vec<i32> = filter.event_types.clone();

        // Increment active stream count and capture handles for drain tracking.
        let active_streams = self.shutdown.active_streams();
        active_streams.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let shutdown_token = self.shutdown.token();

        tokio::spawn(async move {
            // ------------------------------------------------------------------
            // Phase 1: Initial snapshot (if requested)
            // ------------------------------------------------------------------
            if filter.initial_snapshot {
                let sessions = registry.get_all().await;
                let now = chrono::Utc::now();
                let ts = Some(prost_types::Timestamp {
                    seconds: now.timestamp(),
                    nanos: now.timestamp_subsec_nanos() as i32,
                });

                for session in &sessions {
                    // Apply session_id filter to snapshot events too.
                    if let Some(ref filter_session_id) = filter.session_id {
                        if session.id != *filter_session_id {
                            continue;
                        }
                    }

                    // Apply event type filter: snapshot events are SessionStarted.
                    if !allowed_event_types.is_empty()
                        && !allowed_event_types.contains(&(proto::EventType::SessionStarted as i32))
                    {
                        continue;
                    }

                    let event = proto::SessionEvent {
                        session_id: session.id.clone(),
                        ts,
                        payload: Some(proto::session_event::Payload::Started(
                            proto::SessionStarted {
                                session: Some(super::session_to_proto(session)),
                                is_snapshot: true,
                            },
                        )),
                        agent_name: agent_name.clone(),
                    };

                    if tx.send(Ok(event)).await.is_err() {
                        tracing::debug!("stream_events client disconnected during snapshot");
                        active_streams.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                        return;
                    }
                }
            }

            // ------------------------------------------------------------------
            // Phase 2: Live event forwarding
            // ------------------------------------------------------------------
            loop {
                tokio::select! {
                    _ = shutdown_token.cancelled() => {
                        tracing::info!("stream_events: shutdown signal received, sending GoingAway");
                        let now = chrono::Utc::now();
                        let ts = Some(prost_types::Timestamp {
                            seconds: now.timestamp(),
                            nanos: now.timestamp_subsec_nanos() as i32,
                        });
                        let going_away_event = proto::SessionEvent {
                            session_id: String::new(),
                            ts,
                            payload: Some(proto::session_event::Payload::GoingAway(
                                proto::GoingAway {
                                    reason: "agent shutting down".to_string(),
                                    drain_timeout_ms: 5000,
                                },
                            )),
                            agent_name: agent_name.clone(),
                        };
                        let _ = tx.send(Ok(going_away_event)).await;
                        break;
                    }
                    recv_result = broadcast_rx.recv() => {
                        match recv_result {
                            Ok(arc_event) => {
                                // Apply filter: skip events that don't match the requested session_id.
                                if let Some(ref filter_session_id) = filter.session_id {
                                    if arc_event.session_id != *filter_session_id {
                                        continue;
                                    }
                                }

                                // Apply event type filter: map payload variant to EventType
                                // and check against the allowed list. Empty list = pass all.
                                if !allowed_event_types.is_empty() {
                                    let event_type = match &arc_event.payload {
                                        Some(proto::session_event::Payload::Started(_)) => {
                                            proto::EventType::SessionStarted as i32
                                        }
                                        Some(proto::session_event::Payload::Heartbeat(_)) => {
                                            proto::EventType::HeartbeatReceived as i32
                                        }
                                        Some(proto::session_event::Payload::StatusChanged(_)) => {
                                            proto::EventType::StatusChanged as i32
                                        }
                                        Some(proto::session_event::Payload::Stopped(_)) => {
                                            proto::EventType::SessionStopped as i32
                                        }
                                        Some(proto::session_event::Payload::GoingAway(_)) => {
                                            proto::EventType::GoingAway as i32
                                        }
                                        None => proto::EventType::Unspecified as i32,
                                    };
                                    if !allowed_event_types.contains(&event_type) {
                                        continue;
                                    }
                                }

                                // Stamp the agent name on every forwarded event.
                                // Clone the inner event to allow mutation; Arc pointer clone
                                // was already cheap on the broadcast side.
                                let mut event = (*arc_event).clone();
                                event.agent_name = agent_name.clone();

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
                }
            }

            // Decrement active stream count on exit.
            active_streams.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        });

        Ok(Response::new(tokio_stream::wrappers::ReceiverStream::new(
            rx,
        )))
    }
}

// ---------------------------------------------------------------------------
// Git helpers for project info collection
// ---------------------------------------------------------------------------

/// Run a git command in `dir` and return stdout as a trimmed string.
/// Returns `None` on error or if git is not available.
pub(super) async fn git_run(dir: &str, args: &[&str]) -> Option<String> {
    if dir.is_empty() {
        return None;
    }
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    }
}

/// Collect git metadata for a project at `path` and return a `ProjectInfo`.
pub(super) async fn collect_project_info(name: &str, path: &str) -> proto::ProjectInfo {
    // Verify the path looks like a real directory before shelling out.
    let path_exists = !path.is_empty() && std::path::Path::new(path).is_dir();

    if !path_exists {
        return proto::ProjectInfo {
            name: name.to_string(),
            path: if path.is_empty() {
                None
            } else {
                Some(path.to_string())
            },
            git_branch: None,
            last_commit: None,
            sync_status: proto::SyncStatus::Unknown as i32,
            commits_behind: None,
        };
    }

    let branch = git_run(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let last_commit = git_run(path, &["log", "-1", "--format=%H"]).await;

    // Count commits behind remote tracking branch.
    let behind_str = git_run(path, &["rev-list", "HEAD..@{u}", "--count"]).await;
    let (sync_status, commits_behind) = match behind_str.as_deref() {
        Some("0") => (proto::SyncStatus::Synced as i32, Some(0)),
        Some(n) => {
            let count: i32 = n.parse().unwrap_or(0);
            (proto::SyncStatus::Behind as i32, Some(count))
        }
        None => (proto::SyncStatus::Unknown as i32, None),
    };

    proto::ProjectInfo {
        name: name.to_string(),
        path: Some(path.to_string()),
        git_branch: branch,
        last_commit,
        sync_status,
        commits_behind,
    }
}
