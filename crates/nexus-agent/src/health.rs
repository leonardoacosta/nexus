use std::sync::Arc;
use std::time::Duration;

use nexus_core::health::{ContainerStatus, MachineHealth};
use sysinfo::System;
use tokio::sync::RwLock;

/// Shared health state that is periodically refreshed in the background.
#[derive(Clone)]
pub struct HealthCollector {
    state: Arc<RwLock<MachineHealth>>,
}

impl HealthCollector {
    /// Create a new collector and spawn a background refresh task.
    ///
    /// The background task refreshes health metrics every `interval`.
    /// CPU percentage requires two samples, so the first reading may be low.
    pub fn spawn(interval: Duration) -> Self {
        let initial = collect_health_snapshot();
        let state = Arc::new(RwLock::new(initial));

        let collector = Self {
            state: state.clone(),
        };

        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            // The first tick fires immediately — skip it since we already have an initial snapshot.
            tick.tick().await;

            loop {
                tick.tick().await;
                let snapshot = tokio::task::spawn_blocking(collect_health_snapshot)
                    .await
                    .unwrap_or_else(|_| collect_fallback());
                *state.write().await = snapshot;
            }
        });

        collector
    }

    /// Get the latest cached health snapshot.
    pub async fn get(&self) -> MachineHealth {
        self.state.read().await.clone()
    }
}

/// Collect a point-in-time health snapshot using sysinfo.
///
/// CPU percentage is computed by refreshing twice with a short delay — sysinfo
/// needs two data points to calculate utilisation.
fn collect_health_snapshot() -> MachineHealth {
    let mut sys = System::new_all();
    // First refresh populates baseline; sleep then refresh again for CPU delta.
    std::thread::sleep(Duration::from_millis(200));
    sys.refresh_all();

    let cpu_percent = sys.global_cpu_usage();

    let memory_used_gb = sys.used_memory() as f32 / 1_073_741_824.0;
    let memory_total_gb = sys.total_memory() as f32 / 1_073_741_824.0;

    let (disk_used_gb, disk_total_gb) = {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mut used: u64 = 0;
        let mut total: u64 = 0;
        for disk in disks.list() {
            total += disk.total_space();
            used += disk.total_space() - disk.available_space();
        }
        (
            used as f32 / 1_073_741_824.0,
            total as f32 / 1_073_741_824.0,
        )
    };

    let load_avg = {
        let la = System::load_average();
        [la.one as f32, la.five as f32, la.fifteen as f32]
    };

    let uptime_seconds = System::uptime();

    let docker_containers = detect_docker_containers();

    MachineHealth {
        cpu_percent,
        memory_used_gb,
        memory_total_gb,
        disk_used_gb,
        disk_total_gb,
        load_avg,
        uptime_seconds,
        docker_containers,
    }
}

/// Fallback snapshot when spawn_blocking panics.
fn collect_fallback() -> MachineHealth {
    MachineHealth {
        cpu_percent: 0.0,
        memory_used_gb: 0.0,
        memory_total_gb: 0.0,
        disk_used_gb: 0.0,
        disk_total_gb: 0.0,
        load_avg: [0.0; 3],
        uptime_seconds: 0,
        docker_containers: None,
    }
}

/// Detect running Docker containers by shelling out to `docker ps`.
///
/// Returns `None` if Docker is not installed or the command fails.
fn detect_docker_containers() -> Option<Vec<ContainerStatus>> {
    let output = std::process::Command::new("docker")
        .args(["ps", "--format", "{{json .}}"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // Docker JSON output includes "Names" and "State" fields.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            let name = value
                .get("Names")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let running = value
                .get("State")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s == "running");
            containers.push(ContainerStatus { name, running });
        }
    }

    Some(containers)
}
