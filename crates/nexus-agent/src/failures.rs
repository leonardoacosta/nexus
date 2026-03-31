//! In-memory failure ring buffer for tool failure tracking.
//!
//! Stores `FailureEvent`s in a fixed-capacity `VecDeque` with a 30-day
//! rolling window. Thread-safe via `Arc<RwLock<...>>` for concurrent
//! reads from HTTP handlers and writes from the socket event handler.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Maximum number of events stored in the ring buffer.
const MAX_CAPACITY: usize = 10_000;

/// Rolling window duration in days.
const ROLLING_WINDOW_DAYS: i64 = 30;

/// A single tool failure event captured from CC telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureEvent {
    pub timestamp: DateTime<Utc>,
    pub tool_name: String,
    pub error_summary: String,
    pub project: String,
    pub session_id: String,
}

/// Raw JSONL entry for deserialization during bootstrap.
///
/// The `timestamp` field may carry a fixed UTC offset (e.g. `-05:00`), so we
/// deserialize into `DateTime<chrono::FixedOffset>` and convert to UTC in the
/// caller.
#[derive(Debug, Deserialize)]
struct JsonlEntry {
    timestamp: DateTime<chrono::FixedOffset>,
    tool_name: String,
    error_summary: String,
    project: String,
    session_id: Option<String>,
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

/// Thread-safe in-memory ring buffer for failure events.
#[derive(Debug, Clone)]
pub struct FailureBuffer {
    inner: Arc<RwLock<VecDeque<FailureEvent>>>,
}

impl FailureBuffer {
    /// Create a new empty failure buffer.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(VecDeque::with_capacity(MAX_CAPACITY))),
        }
    }

    /// Push a failure event into the buffer.
    ///
    /// Evicts the oldest entries if:
    /// - The buffer is at capacity (`MAX_CAPACITY`)
    /// - The oldest entry is older than the 30-day rolling window
    pub async fn push(&self, event: FailureEvent) {
        let mut buf = self.inner.write().await;

        // Evict entries older than the rolling window.
        let cutoff = Utc::now() - Duration::days(ROLLING_WINDOW_DAYS);
        while buf.front().is_some_and(|e| e.timestamp < cutoff) {
            buf.pop_front();
        }

        // Evict oldest if at capacity.
        if buf.len() >= MAX_CAPACITY {
            buf.pop_front();
        }

        buf.push_back(event);
    }

    /// Query failures within the last `days` days.
    ///
    /// Returns aggregated counts by tool, project, top errors, and a daily
    /// trend. If `days` is 0, queries the entire buffer.
    pub async fn query(&self, days: u32) -> FailureQueryResult {
        let buf = self.inner.read().await;

        let cutoff = if days > 0 {
            Utc::now() - Duration::days(i64::from(days))
        } else {
            DateTime::<Utc>::MIN_UTC
        };

        let mut total = 0usize;
        let mut by_tool: HashMap<String, usize> = HashMap::new();
        let mut by_project: HashMap<String, usize> = HashMap::new();
        let mut error_counts: HashMap<String, usize> = HashMap::new();
        let mut daily_counts: HashMap<String, usize> = HashMap::new();

        for event in buf.iter() {
            if event.timestamp < cutoff {
                continue;
            }
            total += 1;
            *by_tool.entry(event.tool_name.clone()).or_default() += 1;
            *by_project.entry(event.project.clone()).or_default() += 1;
            *error_counts.entry(event.error_summary.clone()).or_default() += 1;

            let date_key = event.timestamp.format("%Y-%m-%d").to_string();
            *daily_counts.entry(date_key).or_default() += 1;
        }

        // Sort errors by count descending, take top 10.
        let mut top_errors: Vec<(String, usize)> = error_counts.into_iter().collect();
        top_errors.sort_by(|a, b| b.1.cmp(&a.1));
        top_errors.truncate(10);

        // Build trend sorted by date descending (most recent first).
        let mut trend: Vec<TrendEntry> = daily_counts
            .into_iter()
            .map(|(date, count)| TrendEntry { date, count })
            .collect();
        trend.sort_by(|a, b| b.date.cmp(&a.date));

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
        let buf = self.inner.read().await;
        let now = Utc::now();
        let period = i64::from(days);
        let current_cutoff = now - Duration::days(period);
        let previous_cutoff = current_cutoff - Duration::days(period);

        let mut current_total: u64 = 0;
        let mut previous_total: u64 = 0;
        let mut by_tool: HashMap<String, u64> = HashMap::new();
        let mut by_project: HashMap<String, u64> = HashMap::new();
        // Key: truncated summary -> (count, tool_name of first occurrence)
        let mut error_groups: HashMap<String, (u64, String)> = HashMap::new();

        for event in buf.iter() {
            if event.timestamp >= current_cutoff {
                current_total += 1;
                *by_tool.entry(event.tool_name.clone()).or_default() += 1;

                let proj = if event.project.is_empty() {
                    "(global)".to_string()
                } else {
                    event.project.clone()
                };
                *by_project.entry(proj).or_default() += 1;

                let summary = truncate_error_summary(&event.error_summary, 60);
                let entry = error_groups
                    .entry(summary)
                    .or_insert((0, event.tool_name.clone()));
                entry.0 += 1;
            } else if event.timestamp >= previous_cutoff {
                previous_total += 1;
            }
        }

        // Sort top errors by count descending, take top 10.
        let mut top_errors: Vec<HttpTopError> = error_groups
            .into_iter()
            .map(|(summary, (count, tool))| HttpTopError {
                summary,
                count,
                tool,
            })
            .collect();
        top_errors.sort_by(|a, b| b.count.cmp(&a.count));
        top_errors.truncate(10);

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

    /// Return the current number of events in the buffer.
    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }

    /// Return true if the buffer is empty.
    pub async fn is_empty(&self) -> bool {
        self.inner.read().await.is_empty()
    }

    /// Bootstrap the buffer from historical JSONL files on disk.
    ///
    /// Reads all `*.jsonl` files in `dir`, parses each line as a JSON object
    /// with fields `timestamp`, `tool_name`, `error_summary`, `project`, and
    /// `session_id`. Only imports entries from the last 30 days (consistent
    /// with the buffer's rolling window). Malformed lines are silently skipped.
    ///
    /// Returns the number of events imported.
    pub async fn bootstrap_from_jsonl(&self, dir: &Path) -> usize {
        let cutoff = Utc::now() - Duration::days(ROLLING_WINDOW_DAYS);

        // Collect and sort JSONL files so import order is deterministic.
        let mut jsonl_files: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "jsonl"))
                .collect(),
            Err(e) => {
                tracing::warn!(dir = %dir.display(), error = %e, "failed to read failures JSONL directory");
                return 0;
            }
        };
        jsonl_files.sort();

        let mut imported = 0usize;
        let mut buf = self.inner.write().await;

        for path in &jsonl_files {
            let contents = match std::fs::read_to_string(path) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "failed to read JSONL file");
                    continue;
                }
            };

            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }

                // Parse the JSON line. Timestamps may carry a fixed offset
                // (e.g. "-05:00"), so deserialize as FixedOffset first.
                let raw: JsonlEntry = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue, // silently skip malformed lines
                };

                let ts_utc = raw.timestamp.to_utc();

                // Only import entries within the rolling window.
                if ts_utc < cutoff {
                    continue;
                }

                let event = FailureEvent {
                    timestamp: ts_utc,
                    tool_name: raw.tool_name,
                    error_summary: raw.error_summary,
                    project: raw.project,
                    session_id: raw.session_id.unwrap_or_default(),
                };

                // Evict oldest if at capacity.
                if buf.len() >= MAX_CAPACITY {
                    buf.pop_front();
                }
                buf.push_back(event);
                imported += 1;
            }
        }

        imported
    }
}

impl Default for FailureBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Truncate an error summary to at most `max_len` characters (first line only).
fn truncate_error_summary(s: &str, max_len: usize) -> String {
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() > max_len {
        format!("{}...", &first_line[..max_len])
    } else {
        first_line.to_string()
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

    fn make_event(tool: &str, project: &str, error: &str) -> FailureEvent {
        FailureEvent {
            timestamp: Utc::now(),
            tool_name: tool.to_string(),
            error_summary: error.to_string(),
            project: project.to_string(),
            session_id: "test-session".to_string(),
        }
    }

    fn make_event_at(tool: &str, project: &str, error: &str, ts: DateTime<Utc>) -> FailureEvent {
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
        let buf = FailureBuffer::new();
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
    async fn evicts_old_entries_on_push() {
        let buf = FailureBuffer::new();

        // Insert an event from 31 days ago.
        let old_ts = Utc::now() - Duration::days(31);
        buf.push(make_event_at("Bash", "oo", "old error", old_ts))
            .await;
        assert_eq!(buf.len().await, 1);

        // Push a new event — the old one should be evicted.
        buf.push(make_event("Read", "tc", "new error")).await;
        assert_eq!(buf.len().await, 1);

        let result = buf.query(0).await;
        assert_eq!(result.total, 1);
        assert_eq!(*result.by_tool.get("Read").unwrap(), 1);
    }

    #[tokio::test]
    async fn query_respects_window() {
        let buf = FailureBuffer::new();

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
        let buf = FailureBuffer::new();
        let result = buf.query(7).await;
        assert_eq!(result.total, 0);
        assert!(result.by_tool.is_empty());
        assert!(result.by_project.is_empty());
        assert!(result.top_errors.is_empty());
        assert!(result.trend.is_empty());
    }

    #[tokio::test]
    async fn capacity_eviction() {
        let buf = FailureBuffer::new();

        // Fill to capacity.
        for i in 0..MAX_CAPACITY {
            buf.push(make_event("Bash", "oo", &format!("error-{i}")))
                .await;
        }
        assert_eq!(buf.len().await, MAX_CAPACITY);

        // Push one more — oldest should be evicted.
        buf.push(make_event("Read", "tc", "overflow")).await;
        assert_eq!(buf.len().await, MAX_CAPACITY);
    }

    // -- HTTP query tests --

    #[tokio::test]
    async fn query_http_empty_buffer() {
        let buf = FailureBuffer::new();
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
        let buf = FailureBuffer::new();
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
        // Both errors appear exactly twice — order between equal counts is not
        // deterministic (HashMap-backed aggregation), so search by summary.
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
        let buf = FailureBuffer::new();
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
        let buf = FailureBuffer::new();
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
    async fn query_http_truncates_long_errors() {
        let buf = FailureBuffer::new();
        let long_error = "a".repeat(100);
        buf.push(make_event("Bash", "cc", &long_error)).await;

        let resp = buf.query_http(7).await;
        assert_eq!(resp.top_errors.len(), 1);
        assert!(resp.top_errors[0].summary.len() <= 63); // 60 + "..."
        assert!(resp.top_errors[0].summary.ends_with("..."));
    }

    #[tokio::test]
    async fn query_http_empty_project_becomes_global() {
        let buf = FailureBuffer::new();
        buf.push(make_event("Bash", "", "fail")).await;

        let resp = buf.query_http(7).await;
        assert_eq!(*resp.by_project.get("(global)").unwrap(), 1);
    }

    #[test]
    fn truncate_error_summary_short() {
        assert_eq!(truncate_error_summary("short", 60), "short");
    }

    #[test]
    fn truncate_error_summary_long() {
        let long = "x".repeat(100);
        let result = truncate_error_summary(&long, 60);
        assert_eq!(result.len(), 63);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn truncate_error_summary_multiline() {
        let multi = "first line\nsecond line\nthird line";
        assert_eq!(truncate_error_summary(multi, 60), "first line");
    }
}
