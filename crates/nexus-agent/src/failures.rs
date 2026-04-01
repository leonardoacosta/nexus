//! SQL-backed failure store for tool failure tracking.
//!
//! Replaced the in-memory `VecDeque` ring buffer with `NexusDb` queries.
//! The `FailureBuffer` struct name is preserved for API compatibility.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{Duration, Utc};
use nexus_core::db::{FailureRecord, NexusDb};
use serde::{Deserialize, Serialize};

/// A single tool failure event captured from CC telemetry.
///
/// This type is used at the ingestion boundary (socket handler) before
/// converting to `FailureRecord` for DB storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureEvent {
    pub timestamp: chrono::DateTime<Utc>,
    pub tool_name: String,
    pub error_summary: String,
    pub project: String,
    pub session_id: String,
}

/// Aggregated query result returned by `FailureBuffer::query`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureQueryResult {
    /// Number of failures in the queried window.
    pub total: usize,
    /// Failures grouped by tool name.
    pub by_tool: HashMap<String, usize>,
    /// Failures grouped by project.
    pub by_project: HashMap<String, usize>,
    /// Top error summaries with their counts (descending).
    pub top_errors: Vec<(String, usize)>,
    /// Daily failure counts for trend analysis (most recent first).
    pub trend: Vec<TrendEntry>,
    /// The time window covered by this query.
    pub window_days: u32,
}

/// A single day's failure count for trend reporting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendEntry {
    pub date: String,
    pub count: usize,
}

/// SQL-backed failure store. Drop-in replacement for the old VecDeque buffer.
#[derive(Debug, Clone)]
pub struct FailureBuffer {
    db: Arc<NexusDb>,
}

impl FailureBuffer {
    /// Create a new failure buffer backed by the given database.
    pub fn new(db: Arc<NexusDb>) -> Self {
        Self { db }
    }

    /// Record a failure event (writes to SQLite).
    pub async fn push(&self, event: FailureEvent) {
        let record = FailureRecord {
            timestamp: event.timestamp.to_rfc3339(),
            tool_name: event.tool_name,
            error_summary: Some(event.error_summary),
            project: Some(event.project),
            session_id: Some(event.session_id),
        };
        if let Err(e) = self.db.insert_failure(&record) {
            tracing::warn!(error = %e, "failed to insert failure into DB");
        }
    }

    /// Query failures within the last `days` days.
    ///
    /// Returns aggregated counts by tool, project, top errors, and a daily
    /// trend. If `days` is 0, queries the entire table.
    pub async fn query(&self, days: u32) -> FailureQueryResult {
        let since = if days > 0 {
            (Utc::now() - Duration::days(i64::from(days))).to_rfc3339()
        } else {
            "1970-01-01T00:00:00Z".to_string()
        };

        let trend_days = if days > 0 { i64::from(days) } else { 36500 };

        let by_tool_raw = self.db.count_by_tool(&since).unwrap_or_default();
        let by_project_raw = self.db.count_by_project(&since).unwrap_or_default();
        let trend_raw = self.db.failure_trend(trend_days).unwrap_or_default();
        let top_errors_raw = self.db.top_errors(&since, 10).unwrap_or_default();

        let total: usize = by_tool_raw.iter().map(|(_, c)| *c as usize).sum();
        let by_tool: HashMap<String, usize> = by_tool_raw
            .into_iter()
            .map(|(k, v)| (k, v as usize))
            .collect();
        let by_project: HashMap<String, usize> = by_project_raw
            .into_iter()
            .map(|(k, v)| (k, v as usize))
            .collect();
        let top_errors: Vec<(String, usize)> = top_errors_raw
            .into_iter()
            .map(|(summary, count, _tool)| (summary, count as usize))
            .collect();
        let trend: Vec<TrendEntry> = trend_raw
            .into_iter()
            .map(|(date, count)| TrendEntry {
                date,
                count: count as usize,
            })
            .collect();

        FailureQueryResult {
            total,
            by_tool,
            by_project,
            top_errors,
            trend,
            window_days: days,
        }
    }

    /// Query failures for the HTTP `/failures` endpoint.
    ///
    /// Returns the response in the format expected by the API:
    /// - `by_tool` / `by_project`: sorted by count descending
    /// - `top_errors`: top 10, with tool name and truncated summary (60 chars)
    /// - `trend`: current vs previous period comparison with direction
    pub async fn query_http(&self, days: u32) -> HttpFailuresResponse {
        let period = i64::from(days);
        let now = Utc::now();
        let current_cutoff = (now - Duration::days(period)).to_rfc3339();
        let previous_cutoff = (now - Duration::days(period * 2)).to_rfc3339();

        let current_total = self.db.count_failures_since(&current_cutoff).unwrap_or(0) as u64;
        let previous_total = self
            .db
            .count_failures_between(&previous_cutoff, &current_cutoff)
            .unwrap_or(0) as u64;

        let by_tool_raw = self.db.count_by_tool(&current_cutoff).unwrap_or_default();
        let by_project_raw = self
            .db
            .count_by_project(&current_cutoff)
            .unwrap_or_default();
        let top_errors_raw = self.db.top_errors(&current_cutoff, 10).unwrap_or_default();

        let by_tool: HashMap<String, u64> = by_tool_raw
            .into_iter()
            .map(|(k, v)| (k, v as u64))
            .collect();
        let by_project: HashMap<String, u64> = by_project_raw
            .into_iter()
            .map(|(k, v)| (k, v as u64))
            .collect();

        let top_errors: Vec<HttpTopError> = top_errors_raw
            .into_iter()
            .map(|(summary, count, tool)| HttpTopError {
                summary,
                count: count as u64,
                tool,
            })
            .collect();

        let direction = if current_total > previous_total {
            "up"
        } else if current_total < previous_total {
            "down"
        } else {
            "flat"
        }
        .to_string();

        HttpFailuresResponse {
            period_days: days,
            total: current_total,
            by_tool,
            by_project,
            top_errors,
            trend: HttpTrend {
                current: current_total,
                previous: previous_total,
                direction,
            },
        }
    }
}

// -- HTTP response types for GET /failures --

/// JSON response for the `GET /failures` endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpFailuresResponse {
    pub period_days: u32,
    pub total: u64,
    pub by_tool: HashMap<String, u64>,
    pub by_project: HashMap<String, u64>,
    pub top_errors: Vec<HttpTopError>,
    pub trend: HttpTrend,
}

/// A single entry in the `top_errors` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpTopError {
    pub summary: String,
    pub count: u64,
    pub tool: String,
}

/// Trend comparison between the current and previous period.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpTrend {
    pub current: u64,
    pub previous: u64,
    pub direction: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::db::NexusDb;

    fn test_db() -> Arc<NexusDb> {
        let db = NexusDb::open_in_memory().unwrap();
        db.migrate().unwrap();
        Arc::new(db)
    }

    fn make_event(tool: &str, project: &str, error: &str) -> FailureEvent {
        FailureEvent {
            timestamp: Utc::now(),
            tool_name: tool.to_string(),
            error_summary: error.to_string(),
            project: project.to_string(),
            session_id: "test-session".to_string(),
        }
    }

    fn make_event_at(
        tool: &str,
        project: &str,
        error: &str,
        ts: chrono::DateTime<Utc>,
    ) -> FailureEvent {
        FailureEvent {
            timestamp: ts,
            tool_name: tool.to_string(),
            error_summary: error.to_string(),
            project: project.to_string(),
            session_id: "test-session".to_string(),
        }
    }

    #[tokio::test]
    async fn push_and_query_basic() {
        let buf = FailureBuffer::new(test_db());
        buf.push(make_event("Bash", "oo", "command failed")).await;
        buf.push(make_event("Read", "tc", "file not found")).await;
        buf.push(make_event("Bash", "oo", "command failed")).await;

        let result = buf.query(7).await;
        assert_eq!(result.total, 3);
        assert_eq!(*result.by_tool.get("Bash").unwrap(), 2);
        assert_eq!(*result.by_tool.get("Read").unwrap(), 1);
        assert_eq!(*result.by_project.get("oo").unwrap(), 2);
        assert_eq!(*result.by_project.get("tc").unwrap(), 1);
        assert_eq!(result.top_errors[0].0, "command failed");
        assert_eq!(result.top_errors[0].1, 2);
    }

    #[tokio::test]
    async fn query_respects_window() {
        let buf = FailureBuffer::new(test_db());

        // Event from 10 days ago.
        let ts_10d = Utc::now() - Duration::days(10);
        buf.push(make_event_at("Bash", "oo", "older", ts_10d)).await;

        // Event from today.
        buf.push(make_event("Read", "tc", "recent")).await;

        // Query last 7 days — should only get the recent event.
        let result = buf.query(7).await;
        assert_eq!(result.total, 1);
        assert_eq!(*result.by_tool.get("Read").unwrap(), 1);

        // Query last 30 days — should get both.
        let result = buf.query(30).await;
        assert_eq!(result.total, 2);
    }

    #[tokio::test]
    async fn empty_buffer_query() {
        let buf = FailureBuffer::new(test_db());
        let result = buf.query(7).await;
        assert_eq!(result.total, 0);
        assert!(result.by_tool.is_empty());
        assert!(result.by_project.is_empty());
        assert!(result.top_errors.is_empty());
        assert!(result.trend.is_empty());
    }

    // -- HTTP query tests --

    #[tokio::test]
    async fn query_http_empty_buffer() {
        let buf = FailureBuffer::new(test_db());
        let resp = buf.query_http(7).await;
        assert_eq!(resp.period_days, 7);
        assert_eq!(resp.total, 0);
        assert!(resp.by_tool.is_empty());
        assert!(resp.by_project.is_empty());
        assert!(resp.top_errors.is_empty());
        assert_eq!(resp.trend.direction, "flat");
        assert_eq!(resp.trend.current, 0);
        assert_eq!(resp.trend.previous, 0);
    }

    #[tokio::test]
    async fn query_http_aggregation() {
        let buf = FailureBuffer::new(test_db());
        buf.push(make_event("Bash", "cc", "command failed")).await;
        buf.push(make_event("Edit", "cc", "old_string not found"))
            .await;
        buf.push(make_event("Bash", "oo", "command failed")).await;
        buf.push(make_event("Edit", "cc", "old_string not found"))
            .await;

        let resp = buf.query_http(7).await;
        assert_eq!(resp.total, 4);
        assert_eq!(*resp.by_tool.get("Bash").unwrap(), 2);
        assert_eq!(*resp.by_tool.get("Edit").unwrap(), 2);
        assert_eq!(*resp.by_project.get("cc").unwrap(), 3);
        assert_eq!(*resp.by_project.get("oo").unwrap(), 1);
        assert_eq!(resp.top_errors.len(), 2);
        // Both errors appear exactly twice — search by summary.
        let edit_err = resp
            .top_errors
            .iter()
            .find(|e| e.summary == "old_string not found")
            .expect("expected 'old_string not found' in top_errors");
        assert_eq!(edit_err.count, 2);
        assert_eq!(edit_err.tool, "Edit");
        let bash_err = resp
            .top_errors
            .iter()
            .find(|e| e.summary == "command failed")
            .expect("expected 'command failed' in top_errors");
        assert_eq!(bash_err.count, 2);
    }

    #[tokio::test]
    async fn query_http_trend_up() {
        let buf = FailureBuffer::new(test_db());
        // 3 events in current 7-day period.
        buf.push(make_event("Bash", "cc", "fail")).await;
        buf.push(make_event("Bash", "cc", "fail")).await;
        buf.push(make_event("Bash", "cc", "fail")).await;
        // 1 event in previous 7-day period.
        let prev_ts = Utc::now() - Duration::days(10);
        buf.push(make_event_at("Bash", "cc", "fail", prev_ts)).await;

        let resp = buf.query_http(7).await;
        assert_eq!(resp.total, 3);
        assert_eq!(resp.trend.current, 3);
        assert_eq!(resp.trend.previous, 1);
        assert_eq!(resp.trend.direction, "up");
    }

    #[tokio::test]
    async fn query_http_trend_down() {
        let buf = FailureBuffer::new(test_db());
        // 1 event in current 7-day period.
        buf.push(make_event("Bash", "cc", "fail")).await;
        // 3 events in previous 7-day period.
        for _ in 0..3 {
            let prev_ts = Utc::now() - Duration::days(10);
            buf.push(make_event_at("Bash", "cc", "fail", prev_ts)).await;
        }

        let resp = buf.query_http(7).await;
        assert_eq!(resp.trend.direction, "down");
    }

    #[tokio::test]
    async fn query_http_empty_project_becomes_global() {
        let buf = FailureBuffer::new(test_db());
        buf.push(make_event("Bash", "", "fail")).await;

        let resp = buf.query_http(7).await;
        assert_eq!(*resp.by_project.get("(global)").unwrap(), 1);
    }
}
