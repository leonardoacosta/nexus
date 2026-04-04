use nexus_core::proto;
use tonic::{Request, Response, Status};

use super::NexusAgentService;

impl NexusAgentService {
    /// GetSessionHistory — daily session counts and costs over the requested window.
    pub(super) async fn handle_get_session_history(
        &self,
        request: Request<proto::SessionHistoryRequest>,
    ) -> Result<Response<proto::SessionHistoryResponse>, Status> {
        let req = request.into_inner();
        let days = req.days.max(1) as i64;

        let entries = self
            .db
            .read(|conn| {
                let mut conditions = vec!["started_at >= datetime('now', ?1)".to_string()];
                let mut bind_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
                bind_values.push(Box::new(format!("-{days} days")));

                if let Some(ref project) = req.project {
                    conditions.push(format!("project = ?{}", bind_values.len() + 1));
                    bind_values.push(Box::new(project.clone()));
                }

                let where_clause = conditions.join(" AND ");
                let sql = format!(
                    "SELECT DATE(started_at) as day,
                            COUNT(*) as cnt,
                            COALESCE(SUM(total_cost_usd), 0.0) as cost
                     FROM sessions
                     WHERE {where_clause}
                     GROUP BY day ORDER BY day DESC"
                );

                let params: Vec<&dyn rusqlite::types::ToSql> =
                    bind_values.iter().map(|b| b.as_ref()).collect();
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params.as_slice(), |row| {
                    Ok(proto::SessionHistoryEntry {
                        date: row.get(0)?,
                        session_count: row.get(1)?,
                        total_cost_usd: row.get(2)?,
                    })
                })?;
                let mut results = Vec::new();
                for row in rows {
                    results.push(row?);
                }
                Ok(results)
            })
            .map_err(|e| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!("gRPC GetSessionHistory failed: {e}")),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::internal(format!("db error: {e}"))
            })?;

        Ok(Response::new(proto::SessionHistoryResponse { entries }))
    }

    /// GetFailureTrends — daily failure counts + per-tool breakdown.
    pub(super) async fn handle_get_failure_trends(
        &self,
        request: Request<proto::FailureTrendsRequest>,
    ) -> Result<Response<proto::FailureTrendsResponse>, Status> {
        let req = request.into_inner();
        let days = req.days.max(1) as i64;

        let daily = self
            .db
            .failure_trend(days)
            .map_err(|e| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!("gRPC GetFailureTrends (failure_trend) failed: {e}")),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::internal(format!("db error: {e}"))
            })?
            .into_iter()
            .map(|(date, count)| proto::FailureTrendEntry {
                date,
                count: count as i32,
            })
            .collect();

        let since = chrono::Utc::now() - chrono::Duration::days(days);
        let by_tool = self
            .db
            .count_by_tool(&since.to_rfc3339())
            .map_err(|e| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!("gRPC GetFailureTrends (count_by_tool) failed: {e}")),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::internal(format!("db error: {e}"))
            })?
            .into_iter()
            .map(|(tool_name, count)| proto::FailureByTool {
                tool_name,
                count: count as i32,
            })
            .collect();

        Ok(Response::new(proto::FailureTrendsResponse {
            daily,
            by_tool,
        }))
    }

    /// GetHealthTimeSeries — health samples over the requested window.
    pub(super) async fn handle_get_health_time_series(
        &self,
        request: Request<proto::HealthTimeSeriesRequest>,
    ) -> Result<Response<proto::HealthTimeSeriesResponse>, Status> {
        let req = request.into_inner();
        let hours = req.hours.max(1) as i64;

        let since = chrono::Utc::now() - chrono::Duration::hours(hours);
        let samples = self
            .db
            .query_health_samples(Some(&since.to_rfc3339()), 10_000)
            .map_err(|e| {
                sentry::add_breadcrumb(sentry::Breadcrumb {
                    ty: "error".into(),
                    category: Some("grpc.call".into()),
                    message: Some(format!("gRPC GetHealthTimeSeries failed: {e}")),
                    level: sentry::Level::Error,
                    ..Default::default()
                });
                Status::internal(format!("db error: {e}"))
            })?
            .into_iter()
            .map(|s| proto::HealthTimeSeriesEntry {
                timestamp: s.timestamp,
                cpu_percent: s.cpu_percent.unwrap_or(0.0) as f32,
                memory_used_gb: s.memory_used_gb.unwrap_or(0.0) as f32,
                disk_used_gb: s.disk_used_gb.unwrap_or(0.0) as f32,
                load1: s.load1.unwrap_or(0.0) as f32,
            })
            .collect();

        Ok(Response::new(proto::HealthTimeSeriesResponse { samples }))
    }

    /// GetSpecVelocity — spec completion progress snapshots over time.
    pub(super) async fn handle_get_spec_velocity(
        &self,
        request: Request<proto::SpecVelocityRequest>,
    ) -> Result<Response<proto::SpecVelocityResponse>, Status> {
        let req = request.into_inner();
        let days = req.days.max(1);
        let limit = days * 24 * 2; // ~2 samples/hr

        let entries = match &req.project {
            Some(project) => self
                .db
                .query_spec_snapshots(project, limit)
                .map_err(|e| {
                    sentry::add_breadcrumb(sentry::Breadcrumb {
                        ty: "error".into(),
                        category: Some("grpc.call".into()),
                        message: Some(format!(
                            "gRPC GetSpecVelocity (project={project}) failed: {e}"
                        )),
                        level: sentry::Level::Error,
                        ..Default::default()
                    });
                    Status::internal(format!("db error: {e}"))
                })?,
            None => {
                let mut all = Vec::new();
                for proj in self.project_registry.all() {
                    let mut snaps = self
                        .db
                        .query_spec_snapshots(&proj.code, limit)
                        .map_err(|e| {
                            sentry::add_breadcrumb(sentry::Breadcrumb {
                                ty: "error".into(),
                                category: Some("grpc.call".into()),
                                message: Some(format!(
                                    "gRPC GetSpecVelocity (project={}) failed: {e}",
                                    proj.code
                                )),
                                level: sentry::Level::Error,
                                ..Default::default()
                            });
                            Status::internal(format!("db error: {e}"))
                        })?;
                    all.append(&mut snaps);
                }
                all.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
                all.truncate(limit as usize);
                all
            }
        };

        let proto_entries = entries
            .into_iter()
            .map(|s| proto::SpecVelocityEntry {
                date: s.timestamp,
                project: s.project,
                spec_name: s.spec_name,
                completed_tasks: s.completed_tasks.unwrap_or(0) as i32,
                total_tasks: s.total_tasks.unwrap_or(0) as i32,
            })
            .collect();

        Ok(Response::new(proto::SpecVelocityResponse {
            entries: proto_entries,
        }))
    }
}
