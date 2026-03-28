//! Telemetry sync service
//!
//! Periodically flushes local telemetry queue to co API.
//! Reads pending events from ~/.claude/scripts/state/telemetry/pending.jsonl
//! and sends them to the co API in batches.

use crate::services::Service;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

const BATCH_SIZE: usize = 100;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const FLUSH_INTERVAL_SECS: u64 = 120; // 2 minutes
const MAX_BACKOFF_SECS: u64 = 1800; // 30 minutes
const MAX_QUEUE_EVENTS: usize = 10_000;
const MAX_EVENT_AGE_SECS: u64 = 7 * 24 * 60 * 60; // 604800 = 7 days

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TelemetryEvent {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    source: String,
    timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    payload: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct IngestRequest {
    events: Vec<TelemetryEvent>,
}

#[derive(Debug, Deserialize)]
struct IngestResponse {
    result: Option<IngestResult>,
}

#[derive(Debug, Deserialize)]
struct IngestResult {
    data: Option<IngestData>,
}

#[derive(Debug, Deserialize)]
struct IngestData {
    ingested: usize,
}

/// Telemetry sync service
pub struct SyncTelemetryService {
    co_api_url: String,
    /// Tracks consecutive flush failures for circuit breaker
    consecutive_failures: AtomicU32,
    /// Current backoff interval in seconds (increases exponentially on failure)
    current_backoff_secs: AtomicU64,
}

impl SyncTelemetryService {
    /// Create new sync telemetry service
    pub fn new() -> Self {
        let co_api_url =
            std::env::var("CO_API_URL").unwrap_or_else(|_| "http://localhost:3002".to_string());

        Self {
            co_api_url,
            consecutive_failures: AtomicU32::new(0),
            current_backoff_secs: AtomicU64::new(0),
        }
    }

    /// Get queue directory path
    fn get_queue_dir() -> Result<PathBuf> {
        let home = std::env::var("HOME").context("HOME environment variable not set")?;
        Ok(PathBuf::from(home)
            .join(".claude")
            .join("scripts")
            .join("state")
            .join("telemetry"))
    }

    /// Read events from queue file
    fn read_queue(queue_file: &Path) -> Result<Vec<TelemetryEvent>> {
        if !queue_file.exists() {
            return Ok(Vec::new());
        }

        let file = File::open(queue_file)
            .with_context(|| format!("Failed to open queue file: {}", queue_file.display()))?;
        let reader = BufReader::new(file);

        let mut events = Vec::new();
        for line in reader.lines() {
            let line = line.context("Failed to read line from queue file")?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            match serde_json::from_str::<TelemetryEvent>(trimmed) {
                Ok(event) => events.push(event),
                Err(_) => {
                    let preview = if trimmed.len() > 50 {
                        format!("{}...", &trimmed[..50])
                    } else {
                        trimmed.to_string()
                    };
                    warn!("Skipping malformed telemetry line: {}", preview);
                }
            }
        }

        Ok(events)
    }

    /// Send batch of events to API (blocking)
    fn send_batch_blocking(endpoint: &str, events: &[TelemetryEvent]) -> Result<usize> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .context("Failed to create HTTP client")?;

        let request = IngestRequest {
            events: events.to_vec(),
        };

        let response = client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .json(&request)
            .send();

        match response {
            Ok(resp) => {
                if !resp.status().is_success() {
                    warn!(
                        "API error: {} {}",
                        resp.status().as_u16(),
                        resp.status().canonical_reason().unwrap_or("Unknown")
                    );
                    return Ok(0);
                }

                let result: IngestResponse = resp.json().context("Failed to parse API response")?;

                let ingested = result
                    .result
                    .and_then(|r| r.data)
                    .map(|d| d.ingested)
                    .unwrap_or(0);

                Ok(ingested)
            }
            Err(e) => {
                debug!("API unreachable: {}", e);
                Ok(0)
            }
        }
    }

    /// Send batch of events to API (async wrapper)
    async fn send_batch(&self, endpoint: &str, events: &[TelemetryEvent]) -> Result<usize> {
        let endpoint = endpoint.to_string();
        let events = events.to_vec();

        tokio::task::spawn_blocking(move || Self::send_batch_blocking(&endpoint, &events))
            .await
            .context("Blocking task failed")?
    }

    /// Write events back to queue file (append mode)
    fn requeue_events(queue_file: &Path, events: &[TelemetryEvent]) -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(queue_file)
            .with_context(|| {
                format!(
                    "Failed to open queue file for writing: {}",
                    queue_file.display()
                )
            })?;

        for event in events {
            let json = serde_json::to_string(event).context("Failed to serialize event")?;
            writeln!(file, "{}", json).context("Failed to write event to queue")?;
        }

        Ok(())
    }

    /// Perform telemetry sync flush
    async fn flush(&self) -> Result<FlushResult> {
        let endpoint = format!("{}/api/trpc/telemetry.events.ingestBatch", self.co_api_url);

        // Get queue paths
        let queue_dir = Self::get_queue_dir()?;
        let queue_file = queue_dir.join("pending.jsonl");
        let processing_file = queue_dir.join("processing.jsonl");

        // Recover from previous incomplete run
        if processing_file.exists() {
            debug!("Previous processing file exists - recovering...");

            // Merge processing file back into queue
            let processing_content =
                fs::read_to_string(&processing_file).context("Failed to read processing file")?;

            let queue_content = if queue_file.exists() {
                fs::read_to_string(&queue_file).context("Failed to read queue file")?
            } else {
                String::new()
            };

            let merged = processing_content + &queue_content;
            fs::write(&queue_file, merged).context("Failed to write merged queue")?;
            fs::remove_file(&processing_file).context("Failed to remove processing file")?;
        }

        // Read events from queue
        let mut events = Self::read_queue(&queue_file)?;

        if events.is_empty() {
            debug!("Queue empty, nothing to sync");
            return Ok(FlushResult {
                total: 0,
                ingested: 0,
                failed_batches: 0,
            });
        }

        // [1.3] Filter out stale events older than MAX_EVENT_AGE_SECS
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let pre_age_count = events.len();
        events.retain(|event| now_secs.saturating_sub(event.timestamp) <= MAX_EVENT_AGE_SECS);
        let stale_dropped = pre_age_count - events.len();
        if stale_dropped > 0 {
            warn!(
                "Dropped {} stale events older than {} days",
                stale_dropped,
                MAX_EVENT_AGE_SECS / 86400
            );
        }

        // [1.2] Cap queue size to MAX_QUEUE_EVENTS, keeping newest events
        if events.len() > MAX_QUEUE_EVENTS {
            let overflow = events.len() - MAX_QUEUE_EVENTS;
            warn!(
                "Queue exceeds cap: dropping {} oldest events (keeping newest {})",
                overflow, MAX_QUEUE_EVENTS
            );
            // Events are in file order (oldest first); drop from the front to keep newest
            events = events.split_off(overflow);
        }

        if events.is_empty() {
            debug!("All events filtered out (stale/overflow), nothing to sync");
            // Clean up the queue file since all events were dropped
            if queue_file.exists() {
                let _ = fs::remove_file(&queue_file);
            }
            return Ok(FlushResult {
                total: 0,
                ingested: 0,
                failed_batches: 0,
            });
        }

        info!("Found {} pending events", events.len());

        // Move queue file to processing to prevent duplicate sends
        fs::rename(&queue_file, &processing_file)
            .context("Failed to rename queue file to processing")?;

        // Send in batches
        let total_batches = (events.len() + BATCH_SIZE - 1) / BATCH_SIZE;
        let mut total_ingested = 0;
        let mut failed_batches = 0;
        let mut requeued_count = 0;
        // [1.1] Circuit breaker: after first failure, skip remaining batches
        let mut api_down = false;

        for (batch_idx, chunk) in events.chunks(BATCH_SIZE).enumerate() {
            let batch_num = batch_idx + 1;

            // If API is down, skip HTTP and requeue immediately
            if api_down {
                debug!(
                    "Skipping batch {}/{} (API down), requeuing {} events",
                    batch_num,
                    total_batches,
                    chunk.len()
                );
                failed_batches += 1;
                requeued_count += chunk.len();
                Self::requeue_events(&queue_file, chunk)?;
                continue;
            }

            debug!(
                "Sending batch {}/{} ({} events)",
                batch_num,
                total_batches,
                chunk.len()
            );

            match self.send_batch(&endpoint, chunk).await {
                Ok(ingested) => {
                    if ingested > 0 {
                        total_ingested += ingested;
                    } else {
                        // API error (returned 0) - mark API as down
                        failed_batches += 1;
                        requeued_count += chunk.len();
                        api_down = true;
                        Self::requeue_events(&queue_file, chunk)?;
                    }
                }
                Err(e) => {
                    // Network error - mark API as down
                    failed_batches += 1;
                    requeued_count += chunk.len();
                    api_down = true;
                    debug!("Batch {} failed: {}", batch_num, e);
                    Self::requeue_events(&queue_file, chunk)?;
                }
            }
        }

        // Remove processing file on success
        if processing_file.exists() {
            fs::remove_file(&processing_file).context("Failed to remove processing file")?;
        }

        info!(
            "Sync complete: {}/{} events sent",
            total_ingested,
            events.len()
        );

        // [1.4] Single consolidated warning for all failures
        if failed_batches > 0 {
            warn!(
                "API unreachable during flush: {} batch(es) failed, {} events re-queued",
                failed_batches, requeued_count
            );
        }

        Ok(FlushResult {
            total: events.len(),
            ingested: total_ingested,
            failed_batches,
        })
    }

    /// Perform a dry run to show pending events
    pub fn dry_run() -> Result<()> {
        let queue_dir = Self::get_queue_dir()?;
        let queue_file = queue_dir.join("pending.jsonl");

        let events = Self::read_queue(&queue_file)?;

        if events.is_empty() {
            info!("Queue empty, nothing to sync");
            return Ok(());
        }

        info!("Dry run - would sync {} events:", events.len());
        let mut by_type: HashMap<String, usize> = HashMap::new();
        for event in &events {
            *by_type.entry(event.event_type.clone()).or_insert(0) += 1;
        }

        let mut types: Vec<_> = by_type.iter().collect();
        types.sort_by_key(|(k, _)| k.as_str());
        for (event_type, count) in types {
            info!("  {}: {}", event_type, count);
        }

        Ok(())
    }

    /// Manual flush for CLI usage
    pub async fn manual_flush() -> Result<FlushResult> {
        let service = Self::new();
        service.flush().await
    }
}

#[derive(Debug)]
pub struct FlushResult {
    pub total: usize,
    pub ingested: usize,
    pub failed_batches: usize,
}

#[async_trait::async_trait]
impl Service for SyncTelemetryService {
    fn name(&self) -> &'static str {
        "sync_telemetry"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!(
            "Telemetry sync service started (flush interval: {}s)",
            FLUSH_INTERVAL_SECS
        );

        loop {
            // Determine sleep duration based on circuit breaker state
            let failures = self.consecutive_failures.load(Ordering::Relaxed);
            let sleep_secs = if failures > 0 {
                let backoff = self.current_backoff_secs.load(Ordering::Relaxed);
                debug!(
                    "Circuit breaker active: {} consecutive failures, backoff {}s",
                    failures, backoff
                );
                backoff
            } else {
                FLUSH_INTERVAL_SECS
            };

            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Telemetry sync service shutting down");
                    break;
                }

                _ = tokio::time::sleep(Duration::from_secs(sleep_secs)) => {
                    match self.flush().await {
                        Ok(result) => {
                            if result.total > 0 {
                                info!(
                                    "Telemetry flush: {}/{} events sent",
                                    result.ingested,
                                    result.total
                                );
                            }

                            // [1.1] Circuit breaker: update backoff state
                            if result.failed_batches > 0 {
                                // Increment consecutive failures
                                let prev = self.consecutive_failures.fetch_add(1, Ordering::Relaxed);
                                // Double backoff, starting from FLUSH_INTERVAL_SECS, capped at MAX_BACKOFF_SECS
                                let new_backoff = if prev == 0 {
                                    FLUSH_INTERVAL_SECS * 2
                                } else {
                                    let current = self.current_backoff_secs.load(Ordering::Relaxed);
                                    (current * 2).min(MAX_BACKOFF_SECS)
                                };
                                self.current_backoff_secs.store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
                                debug!(
                                    "Backoff increased to {}s after {} consecutive failures",
                                    new_backoff.min(MAX_BACKOFF_SECS),
                                    prev + 1
                                );
                            } else if result.ingested > 0 {
                                // Successful flush - reset circuit breaker
                                if self.consecutive_failures.load(Ordering::Relaxed) > 0 {
                                    info!("API recovered, resetting backoff to normal interval");
                                }
                                self.consecutive_failures.store(0, Ordering::Relaxed);
                                self.current_backoff_secs.store(0, Ordering::Relaxed);
                            }
                        }
                        Err(e) => {
                            error!("Telemetry flush failed: {}", e);
                            // Also trigger backoff on hard errors
                            let prev = self.consecutive_failures.fetch_add(1, Ordering::Relaxed);
                            let new_backoff = if prev == 0 {
                                FLUSH_INTERVAL_SECS * 2
                            } else {
                                let current = self.current_backoff_secs.load(Ordering::Relaxed);
                                (current * 2).min(MAX_BACKOFF_SECS)
                            };
                            self.current_backoff_secs.store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn health_check(&self) -> bool {
        // Check if queue directory exists
        if let Ok(queue_dir) = Self::get_queue_dir() {
            queue_dir.exists()
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn test_read_queue_empty() {
        let temp_file = std::env::temp_dir().join("test-empty-queue.jsonl");
        let _ = std::fs::remove_file(&temp_file);

        let events = SyncTelemetryService::read_queue(&temp_file).unwrap();
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn test_read_queue_with_events() {
        let temp_file = std::env::temp_dir().join("test-queue-with-events.jsonl");

        let event = TelemetryEvent {
            id: "test-1".to_string(),
            event_type: "test.event".to_string(),
            source: "test".to_string(),
            timestamp: 1234567890,
            project: Some("test-project".to_string()),
            session_id: Some("test-session".to_string()),
            payload: serde_json::json!({"data": "test"}),
        };

        let mut file = File::create(&temp_file).unwrap();
        writeln!(file, "{}", serde_json::to_string(&event).unwrap()).unwrap();

        let events = SyncTelemetryService::read_queue(&temp_file).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "test-1");

        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_read_queue_skips_malformed() {
        let temp_file = std::env::temp_dir().join("test-queue-malformed.jsonl");

        let mut file = File::create(&temp_file).unwrap();
        writeln!(file, "{{invalid json}}").unwrap();
        writeln!(
            file,
            "{{\"id\":\"test-1\",\"type\":\"test\",\"source\":\"test\",\"timestamp\":123,\"payload\":{{}}}}"
        )
        .unwrap();

        let events = SyncTelemetryService::read_queue(&temp_file).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "test-1");

        let _ = std::fs::remove_file(&temp_file);
    }

    /// T1: Queue exceeds 10k events -> oldest trimmed
    #[test]
    fn test_queue_cap_trims_oldest_events() {
        let dir = tempfile::tempdir().unwrap();
        let queue_file = dir.path().join("cap-test.jsonl");

        // Write 10,050 events with timestamps 1..=10050
        {
            let mut file = File::create(&queue_file).unwrap();
            for i in 1..=10_050u64 {
                let event = TelemetryEvent {
                    id: format!("evt-{}", i),
                    event_type: "test.cap".to_string(),
                    source: "test".to_string(),
                    timestamp: i,
                    project: None,
                    session_id: None,
                    payload: serde_json::json!({}),
                };
                writeln!(file, "{}", serde_json::to_string(&event).unwrap()).unwrap();
            }
        }

        let mut events = SyncTelemetryService::read_queue(&queue_file).unwrap();
        assert_eq!(events.len(), 10_050);

        // Apply the same queue cap logic the flush method uses
        if events.len() > MAX_QUEUE_EVENTS {
            let overflow = events.len() - MAX_QUEUE_EVENTS;
            events = events.split_off(overflow);
        }

        assert_eq!(events.len(), MAX_QUEUE_EVENTS);
        // Oldest 50 dropped; first remaining event should have timestamp 51
        assert_eq!(events[0].timestamp, 51);
        assert_eq!(events[0].id, "evt-51");
        // Last event should still be the newest
        assert_eq!(events.last().unwrap().timestamp, 10_050);
    }

    /// T2: Events older than 7 days -> stale events dropped
    #[test]
    fn test_stale_events_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let queue_file = dir.path().join("stale-test.jsonl");

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let fresh = TelemetryEvent {
            id: "fresh".to_string(),
            event_type: "test".to_string(),
            source: "test".to_string(),
            timestamp: now_secs,
            project: None,
            session_id: None,
            payload: serde_json::json!({}),
        };

        let six_days_ago = TelemetryEvent {
            id: "six-days".to_string(),
            event_type: "test".to_string(),
            source: "test".to_string(),
            timestamp: now_secs - (6 * 24 * 60 * 60), // 6 days ago
            project: None,
            session_id: None,
            payload: serde_json::json!({}),
        };

        let eight_days_ago = TelemetryEvent {
            id: "eight-days".to_string(),
            event_type: "test".to_string(),
            source: "test".to_string(),
            timestamp: now_secs - (8 * 24 * 60 * 60), // 8 days ago
            project: None,
            session_id: None,
            payload: serde_json::json!({}),
        };

        {
            let mut file = File::create(&queue_file).unwrap();
            for event in [&eight_days_ago, &six_days_ago, &fresh] {
                writeln!(file, "{}", serde_json::to_string(event).unwrap()).unwrap();
            }
        }

        let mut events = SyncTelemetryService::read_queue(&queue_file).unwrap();
        assert_eq!(events.len(), 3);

        // Apply the same age filter logic the flush method uses
        events.retain(|event| now_secs.saturating_sub(event.timestamp) <= MAX_EVENT_AGE_SECS);

        // 8-day-old event should be dropped, 6-day and fresh should survive
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, "six-days");
        assert_eq!(events[1].id, "fresh");
    }

    /// T3: Circuit breaker backoff math
    #[test]
    fn test_circuit_breaker_backoff_math() {
        let service = SyncTelemetryService {
            co_api_url: "http://localhost:9999".to_string(),
            consecutive_failures: AtomicU32::new(0),
            current_backoff_secs: AtomicU64::new(0),
        };

        // Simulate failure #1: prev=0, backoff = FLUSH_INTERVAL_SECS * 2 = 240
        let prev = service.consecutive_failures.fetch_add(1, Ordering::Relaxed);
        assert_eq!(prev, 0);
        let new_backoff = if prev == 0 {
            FLUSH_INTERVAL_SECS * 2
        } else {
            let current = service.current_backoff_secs.load(Ordering::Relaxed);
            (current * 2).min(MAX_BACKOFF_SECS)
        };
        service
            .current_backoff_secs
            .store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
        assert_eq!(
            service.current_backoff_secs.load(Ordering::Relaxed),
            240,
            "After 1 failure: backoff should be FLUSH_INTERVAL_SECS * 2 = 240"
        );

        // Simulate failure #2: prev=1, backoff = 240 * 2 = 480
        let prev = service.consecutive_failures.fetch_add(1, Ordering::Relaxed);
        assert_eq!(prev, 1);
        let new_backoff = if prev == 0 {
            FLUSH_INTERVAL_SECS * 2
        } else {
            let current = service.current_backoff_secs.load(Ordering::Relaxed);
            (current * 2).min(MAX_BACKOFF_SECS)
        };
        service
            .current_backoff_secs
            .store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
        assert_eq!(
            service.current_backoff_secs.load(Ordering::Relaxed),
            480,
            "After 2 failures: backoff should be 480"
        );

        // Simulate failure #3: prev=2, backoff = 480 * 2 = 960
        let prev = service.consecutive_failures.fetch_add(1, Ordering::Relaxed);
        assert_eq!(prev, 2);
        let new_backoff = if prev == 0 {
            FLUSH_INTERVAL_SECS * 2
        } else {
            let current = service.current_backoff_secs.load(Ordering::Relaxed);
            (current * 2).min(MAX_BACKOFF_SECS)
        };
        service
            .current_backoff_secs
            .store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
        assert_eq!(
            service.current_backoff_secs.load(Ordering::Relaxed),
            960,
            "After 3 failures: backoff should be 960"
        );

        // Continue doubling until we hit the cap
        // failure #4: 960 * 2 = 1920 -> capped at 1800
        let prev = service.consecutive_failures.fetch_add(1, Ordering::Relaxed);
        let new_backoff = if prev == 0 {
            FLUSH_INTERVAL_SECS * 2
        } else {
            let current = service.current_backoff_secs.load(Ordering::Relaxed);
            (current * 2).min(MAX_BACKOFF_SECS)
        };
        service
            .current_backoff_secs
            .store(new_backoff.min(MAX_BACKOFF_SECS), Ordering::Relaxed);
        assert_eq!(
            service.current_backoff_secs.load(Ordering::Relaxed),
            MAX_BACKOFF_SECS,
            "Backoff should cap at MAX_BACKOFF_SECS (1800)"
        );

        // Simulate success: reset to 0
        service.consecutive_failures.store(0, Ordering::Relaxed);
        service.current_backoff_secs.store(0, Ordering::Relaxed);
        assert_eq!(
            service.consecutive_failures.load(Ordering::Relaxed),
            0,
            "After success: consecutive_failures should be 0"
        );
        assert_eq!(
            service.current_backoff_secs.load(Ordering::Relaxed),
            0,
            "After success: backoff should be 0"
        );
    }

    /// T5: Queue file at nonexistent path -> read_queue returns empty vec
    #[test]
    fn test_read_queue_nonexistent_path() {
        let nonexistent = Path::new("/tmp/absolutely-does-not-exist-telemetry-test/queue.jsonl");
        let events = SyncTelemetryService::read_queue(nonexistent).unwrap();
        assert!(
            events.is_empty(),
            "read_queue on a nonexistent file should return empty vec"
        );
    }
}
