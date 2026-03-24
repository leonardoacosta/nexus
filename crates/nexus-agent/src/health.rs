use std::sync::Arc;
use std::time::Duration;

use nexus_core::health::{ContainerStatus, MachineHealth};
use sysinfo::System;
use tokio::sync::RwLock;

/// How many health ticks to wait between Docker container list refreshes.
/// At a 5-second interval this means Docker is queried every 30 seconds.
const DOCKER_REFRESH_TICKS: u32 = 6;

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
    /// The `System` instance is created once and reused across refreshes to
    /// avoid the ~100-200 MB allocation cost of `System::new_all()` on every tick.
    pub fn spawn(interval: Duration) -> Self {
        let state = Arc::new(RwLock::new(MachineHealth::default()));
        let collector = Self {
            state: state.clone(),
        };

        tokio::spawn(async move {
            // Allocate the System instance once, then refresh in-place on each tick.
            let mut sys = tokio::task::spawn_blocking(|| {
                let mut s = System::new_all();
                // Two-sample CPU measurement: baseline + sleep + refresh.
                std::thread::sleep(Duration::from_millis(200));
                s.refresh_all();
                s
            })
            .await
            .unwrap_or_else(|_| System::new());

            // Populate the initial snapshot immediately.
            let docker_containers = detect_docker_containers();
            *state.write().await = build_health_from_system(&sys, docker_containers.clone());

            let mut tick = tokio::time::interval(interval);
            // Skip the first immediate tick — we already have data above.
            tick.tick().await;

            let mut docker_tick_counter: u32 = 0;
            let mut cached_docker = docker_containers;

            loop {
                tick.tick().await;

                // Refresh Docker container list every DOCKER_REFRESH_TICKS cycles.
                docker_tick_counter += 1;
                if docker_tick_counter >= DOCKER_REFRESH_TICKS {
                    cached_docker = detect_docker_containers();
                    docker_tick_counter = 0;
                }

                let docker_snapshot = cached_docker.clone();

                // Move sys into a blocking thread for the refresh, then get it back.
                let (returned_sys, snapshot) = tokio::task::spawn_blocking(move || {
                    sys.refresh_all();
                    let snapshot = build_health_from_system(&sys, docker_snapshot);
                    (sys, snapshot)
                })
                .await
                .unwrap_or_else(|_| (System::new(), collect_fallback()));

                sys = returned_sys;
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

/// Build a `MachineHealth` snapshot from an already-refreshed `System`.
fn build_health_from_system(
    sys: &System,
    docker_containers: Option<Vec<ContainerStatus>>,
) -> MachineHealth {
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
