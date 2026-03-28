//! Server Monitor Service
//!
//! Lightweight server health monitoring for homelab Linux servers.
//! Periodically checks system metrics and writes state to a JSON file
//! for other tools (statusline, dashboards) to consume.
//!
//! Metrics collected:
//! - Disk usage (via `statvfs` syscall)
//! - Memory usage (parsed from `/proc/meminfo`)
//! - Load average (parsed from `/proc/loadavg`)
//! - Docker container count (via `docker ps` if available)
//!
//! All /proc parsing is best-effort -- missing files are handled gracefully
//! for compatibility with WSL, containers, and non-standard environments.

use crate::services::Service;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Health status thresholds.
const DISK_WARNING_PCT: f64 = 90.0;
const MEMORY_WARNING_PCT: f64 = 95.0;

/// Server health state written to disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerHealth {
    pub timestamp: String,
    pub disk_usage_pct: Option<f64>,
    pub memory_usage_pct: Option<f64>,
    pub load_avg_1m: Option<f64>,
    pub docker_containers: Option<u32>,
    pub status: String,
}

impl Default for ServerHealth {
    fn default() -> Self {
        Self {
            timestamp: String::new(),
            disk_usage_pct: None,
            memory_usage_pct: None,
            load_avg_1m: None,
            docker_containers: None,
            status: "unknown".to_string(),
        }
    }
}

/// Memory info parsed from /proc/meminfo.
#[derive(Debug, Default)]
pub struct MemInfo {
    pub total_kb: u64,
    pub available_kb: u64,
}

/// Parse /proc/meminfo contents into a MemInfo struct.
///
/// Looks for `MemTotal` and `MemAvailable` lines.
/// Returns None if either field is missing or unparseable.
pub fn parse_meminfo(contents: &str) -> Option<MemInfo> {
    let mut total: Option<u64> = None;
    let mut available: Option<u64> = None;

    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            total = parse_kb_value(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            available = parse_kb_value(rest);
        }

        // Stop early once we have both values
        if total.is_some() && available.is_some() {
            break;
        }
    }

    match (total, available) {
        (Some(t), Some(a)) if t > 0 => Some(MemInfo {
            total_kb: t,
            available_kb: a,
        }),
        _ => None,
    }
}

/// Parse a value like "  16384000 kB" into the numeric part.
fn parse_kb_value(s: &str) -> Option<u64> {
    s.trim()
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<u64>().ok())
}

/// Parse /proc/loadavg contents to extract the 1-minute load average.
///
/// Format: "0.50 0.30 0.15 1/234 5678"
pub fn parse_loadavg(contents: &str) -> Option<f64> {
    contents
        .trim()
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
}

/// Get disk usage percentage for a given path using the `statvfs` syscall.
pub fn get_disk_usage_pct(path: &Path) -> Option<f64> {
    use std::ffi::CString;
    use std::mem::MaybeUninit;

    let c_path = match CString::new(path.to_str()?) {
        Ok(p) => p,
        Err(_) => return None,
    };

    let mut stat = MaybeUninit::<libc::statvfs>::uninit();

    // SAFETY: statvfs is a standard POSIX syscall. We pass a valid null-terminated
    // path and an uninitialized struct that gets filled by the kernel.
    let ret = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };

    if ret != 0 {
        return None;
    }

    // SAFETY: statvfs returned 0, so the struct is initialized.
    let stat = unsafe { stat.assume_init() };

    if stat.f_blocks == 0 {
        return None;
    }

    let total = stat.f_blocks as f64;
    let free = stat.f_bfree as f64;
    let used_pct = ((total - free) / total) * 100.0;

    Some((used_pct * 10.0).round() / 10.0) // Round to 1 decimal
}

/// Count running Docker containers by invoking `docker ps -q`.
///
/// Returns None if docker is not available or the command fails.
async fn get_docker_container_count() -> Option<u32> {
    let output = tokio::process::Command::new("docker")
        .args(["ps", "-q"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let count = stdout.lines().filter(|l| !l.trim().is_empty()).count();
    Some(count as u32)
}

/// Determine overall health status from metrics.
fn compute_status(health: &ServerHealth) -> String {
    if let Some(disk) = health.disk_usage_pct {
        if disk >= DISK_WARNING_PCT {
            return "warning".to_string();
        }
    }
    if let Some(mem) = health.memory_usage_pct {
        if mem >= MEMORY_WARNING_PCT {
            return "warning".to_string();
        }
    }
    "healthy".to_string()
}

/// Collect all server health metrics.
async fn collect_health(state_path: &Path) -> ServerHealth {
    let timestamp = chrono::Utc::now().to_rfc3339();

    // Read /proc/meminfo
    let memory_usage_pct = match std::fs::read_to_string("/proc/meminfo") {
        Ok(contents) => parse_meminfo(&contents).map(|info| {
            let used = info.total_kb.saturating_sub(info.available_kb);
            let pct = (used as f64 / info.total_kb as f64) * 100.0;
            (pct * 10.0).round() / 10.0
        }),
        Err(e) => {
            debug!("Could not read /proc/meminfo: {}", e);
            None
        }
    };

    // Read /proc/loadavg
    let load_avg_1m = match std::fs::read_to_string("/proc/loadavg") {
        Ok(contents) => parse_loadavg(&contents),
        Err(e) => {
            debug!("Could not read /proc/loadavg: {}", e);
            None
        }
    };

    // Disk usage for the state file's parent (or root)
    let disk_path = state_path.parent().unwrap_or_else(|| Path::new("/"));
    let disk_usage_pct = get_disk_usage_pct(disk_path);

    // Docker containers (best-effort, may not be installed)
    let docker_containers = get_docker_container_count().await;

    let mut health = ServerHealth {
        timestamp,
        disk_usage_pct,
        memory_usage_pct,
        load_avg_1m,
        docker_containers,
        status: String::new(),
    };

    health.status = compute_status(&health);
    health
}

/// Server monitor daemon service.
///
/// Periodically collects server health metrics and writes them
/// to a JSON state file for consumption by statusline and dashboards.
pub struct ServerMonitorService {
    /// Interval in seconds between health checks.
    interval_secs: u64,
    /// Path to the health state JSON file.
    state_path: PathBuf,
    /// Tracks whether the service is running.
    healthy: Arc<AtomicBool>,
}

impl ServerMonitorService {
    /// Create a new server monitor service.
    pub fn new(interval_secs: u64, state_path: PathBuf) -> Self {
        Self {
            interval_secs,
            state_path,
            healthy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Default state path: `~/.claude/scripts/state/server-health.json`
    pub fn default_state_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/nyaptor".to_string());
        PathBuf::from(home)
            .join(".claude")
            .join("scripts")
            .join("state")
            .join("server-health.json")
    }
}

#[async_trait::async_trait]
impl Service for ServerMonitorService {
    fn name(&self) -> &'static str {
        "server-monitor"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!(
            "Server monitor service starting (interval={}s, state={})",
            self.interval_secs,
            self.state_path.display()
        );

        // Ensure parent directory exists
        if let Some(parent) = self.state_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                error!(
                    "Failed to create state directory {}: {}",
                    parent.display(),
                    e
                );
                return Err(e.into());
            }
        }

        self.healthy.store(true, Ordering::SeqCst);

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(self.interval_secs));

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("Server monitor service shutting down");
                    break;
                }
                _ = interval.tick() => {
                    let health = collect_health(&self.state_path).await;

                    // Log warnings for critical thresholds
                    if let Some(disk) = health.disk_usage_pct {
                        if disk >= DISK_WARNING_PCT {
                            warn!("Disk usage critical: {:.1}%", disk);
                        }
                    }
                    if let Some(mem) = health.memory_usage_pct {
                        if mem >= MEMORY_WARNING_PCT {
                            warn!("Memory usage critical: {:.1}%", mem);
                        }
                    }

                    debug!(
                        "Server health: disk={:?}% mem={:?}% load={:?} docker={:?} status={}",
                        health.disk_usage_pct,
                        health.memory_usage_pct,
                        health.load_avg_1m,
                        health.docker_containers,
                        health.status,
                    );

                    // Write state file
                    match serde_json::to_string_pretty(&health) {
                        Ok(json) => {
                            if let Err(e) = std::fs::write(&self.state_path, json) {
                                error!(
                                    "Failed to write server health state: {}",
                                    e
                                );
                            }
                        }
                        Err(e) => {
                            error!("Failed to serialize server health: {}", e);
                        }
                    }
                }
            }
        }

        self.healthy.store(false, Ordering::SeqCst);
        Ok(())
    }

    async fn health_check(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
    }
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_parse_meminfo_typical() {
        let contents = "\
MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
";
        let info = parse_meminfo(contents).expect("should parse");
        assert_eq!(info.total_kb, 16384000);
        assert_eq!(info.available_kb, 8192000);
    }

    #[test]
    fn test_parse_meminfo_missing_available() {
        let contents = "\
MemTotal:       16384000 kB
MemFree:         2048000 kB
";
        assert!(parse_meminfo(contents).is_none());
    }

    #[test]
    fn test_parse_meminfo_missing_total() {
        let contents = "\
MemAvailable:    8192000 kB
MemFree:         2048000 kB
";
        assert!(parse_meminfo(contents).is_none());
    }

    #[test]
    fn test_parse_meminfo_empty() {
        assert!(parse_meminfo("").is_none());
    }

    #[test]
    fn test_parse_meminfo_zero_total() {
        let contents = "\
MemTotal:              0 kB
MemAvailable:          0 kB
";
        assert!(parse_meminfo(contents).is_none());
    }

    #[test]
    fn test_parse_loadavg_typical() {
        let contents = "0.50 0.30 0.15 1/234 5678\n";
        let load = parse_loadavg(contents).expect("should parse");
        assert!((load - 0.50).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_loadavg_high() {
        let contents = "12.34 8.56 4.12 5/500 12345\n";
        let load = parse_loadavg(contents).expect("should parse");
        assert!((load - 12.34).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_loadavg_empty() {
        assert!(parse_loadavg("").is_none());
    }

    #[test]
    fn test_parse_loadavg_garbage() {
        assert!(parse_loadavg("not a number").is_none());
    }

    #[test]
    fn test_parse_kb_value() {
        assert_eq!(parse_kb_value("  16384000 kB"), Some(16384000));
        assert_eq!(parse_kb_value("0 kB"), Some(0));
        assert_eq!(parse_kb_value("  "), None);
        assert_eq!(parse_kb_value("abc kB"), None);
    }

    #[test]
    fn test_compute_status_healthy() {
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: Some(45.0),
            memory_usage_pct: Some(60.0),
            load_avg_1m: Some(0.5),
            docker_containers: Some(3),
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "healthy");
    }

    #[test]
    fn test_compute_status_disk_warning() {
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: Some(92.0),
            memory_usage_pct: Some(60.0),
            load_avg_1m: Some(0.5),
            docker_containers: None,
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "warning");
    }

    #[test]
    fn test_compute_status_memory_warning() {
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: Some(45.0),
            memory_usage_pct: Some(96.0),
            load_avg_1m: Some(0.5),
            docker_containers: None,
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "warning");
    }

    #[test]
    fn test_compute_status_none_metrics() {
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: None,
            memory_usage_pct: None,
            load_avg_1m: None,
            docker_containers: None,
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "healthy");
    }

    #[test]
    fn test_compute_status_boundary_disk() {
        // Exactly at threshold
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: Some(90.0),
            memory_usage_pct: Some(50.0),
            load_avg_1m: None,
            docker_containers: None,
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "warning");
    }

    #[test]
    fn test_compute_status_boundary_memory() {
        // Exactly at threshold
        let health = ServerHealth {
            timestamp: String::new(),
            disk_usage_pct: Some(50.0),
            memory_usage_pct: Some(95.0),
            load_avg_1m: None,
            docker_containers: None,
            status: String::new(),
        };
        assert_eq!(compute_status(&health), "warning");
    }

    #[test]
    fn test_get_disk_usage_pct_root() {
        // This should work on any Linux system
        let result = get_disk_usage_pct(Path::new("/"));
        assert!(result.is_some(), "Should be able to stat root filesystem");
        let pct = result.expect("disk usage");
        assert!(
            pct >= 0.0 && pct <= 100.0,
            "Percentage should be 0-100, got {}",
            pct
        );
    }

    #[test]
    fn test_get_disk_usage_pct_nonexistent() {
        let result = get_disk_usage_pct(Path::new("/nonexistent/path/that/does/not/exist"));
        assert!(result.is_none());
    }

    #[test]
    fn test_server_health_serialization() {
        let health = ServerHealth {
            timestamp: "2026-02-07T12:00:00+00:00".to_string(),
            disk_usage_pct: Some(45.2),
            memory_usage_pct: Some(62.1),
            load_avg_1m: Some(0.5),
            docker_containers: Some(3),
            status: "healthy".to_string(),
        };

        let json = serde_json::to_string_pretty(&health).expect("should serialize");
        assert!(json.contains("\"disk_usage_pct\": 45.2"));
        assert!(json.contains("\"memory_usage_pct\": 62.1"));
        assert!(json.contains("\"status\": \"healthy\""));

        // Roundtrip
        let parsed: ServerHealth = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed, health);
    }

    #[test]
    fn test_server_health_serialization_nulls() {
        let health = ServerHealth {
            timestamp: "2026-02-07T12:00:00+00:00".to_string(),
            disk_usage_pct: None,
            memory_usage_pct: None,
            load_avg_1m: None,
            docker_containers: None,
            status: "healthy".to_string(),
        };

        let json = serde_json::to_string_pretty(&health).expect("should serialize");
        assert!(json.contains("\"disk_usage_pct\": null"));

        let parsed: ServerHealth = serde_json::from_str(&json).expect("should deserialize");
        assert_eq!(parsed, health);
    }

    #[test]
    fn test_server_monitor_service_new() {
        let service = ServerMonitorService::new(60, PathBuf::from("/tmp/test-health.json"));
        assert_eq!(service.interval_secs, 60);
        assert_eq!(service.name(), "server-monitor");
    }

    #[tokio::test]
    async fn test_server_monitor_health_check_before_start() {
        let service = ServerMonitorService::new(60, PathBuf::from("/tmp/test-health.json"));
        assert!(!service.health_check().await);
    }

    #[test]
    fn test_default_state_path() {
        let path = ServerMonitorService::default_state_path();
        assert!(path
            .to_str()
            .expect("should be valid utf8")
            .ends_with("scripts/state/server-health.json"));
    }

    #[tokio::test]
    async fn test_server_monitor_writes_state_file() {
        let tmp_dir = TempDir::new().expect("should create temp dir");
        let state_path = tmp_dir.path().join("server-health.json");

        let service = ServerMonitorService::new(3600, state_path.clone());
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move { service.start(shutdown_rx).await });

        // Give it time to run the first cycle (interval.tick() fires immediately)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Send shutdown
        let _ = shutdown_tx.send(()).await;

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;

        assert!(result.is_ok(), "Service should shut down within timeout");

        // Verify state file was written
        assert!(
            state_path.exists(),
            "State file should exist after first cycle"
        );

        let contents = std::fs::read_to_string(&state_path).expect("should read state file");
        let health: ServerHealth =
            serde_json::from_str(&contents).expect("should parse health JSON");

        assert!(!health.timestamp.is_empty());
        assert!(
            health.status == "healthy" || health.status == "warning",
            "Status should be healthy or warning, got: {}",
            health.status
        );
    }

    #[tokio::test]
    async fn test_collect_health_returns_valid() {
        let tmp_dir = TempDir::new().expect("should create temp dir");
        let state_path = tmp_dir.path().join("server-health.json");

        let health = collect_health(&state_path).await;

        assert!(!health.timestamp.is_empty());
        assert!(
            health.status == "healthy" || health.status == "warning",
            "Status should be healthy or warning"
        );

        // On a real Linux system, these should be Some
        // (but we don't assert because tests may run in containers without /proc)
        if health.memory_usage_pct.is_some() {
            let pct = health.memory_usage_pct.expect("memory pct");
            assert!(pct >= 0.0 && pct <= 100.0);
        }

        if health.load_avg_1m.is_some() {
            let load = health.load_avg_1m.expect("load avg");
            assert!(load >= 0.0);
        }
    }
}
