use std::sync::Arc;
use std::time::Duration;

use nexus_core::db::{HealthSampleRecord, NexusDb};
use nexus_core::health::{CpuHealth, DiskHealth, DockerHealth, MachineHealth, RamHealth};
use sysinfo::System;
use tokio::sync::RwLock;

/// How many health ticks to wait between Docker container list refreshes.
/// At a 5-second interval this means Docker is queried every 30 seconds.
const DOCKER_REFRESH_TICKS: u32 = 6;

/// How many health ticks to wait between writing a health sample to the DB.
/// At a 5-second interval this means a DB sample every 30 seconds.
const DB_SAMPLE_TICKS: u32 = 6;

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
    pub fn spawn(interval: Duration, token: tokio_util::sync::CancellationToken) -> Self {
        Self::spawn_with_db(interval, None, token)
    }

    /// Create a new collector with optional SQLite backing store for health
    /// sampling. When `db` is `Some`, every 6th refresh tick (30s at 5s
    /// interval) writes a `health_samples` row.
    pub fn spawn_with_db(
        interval: Duration,
        db: Option<Arc<NexusDb>>,
        token: tokio_util::sync::CancellationToken,
    ) -> Self {
        let state = Arc::new(RwLock::new(MachineHealth::default()));
        let collector = Self {
            state: state.clone(),
        };

        let child_token = token.child_token();
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
            let docker = tokio::task::spawn_blocking(detect_docker)
                .await
                .unwrap_or(None);
            *state.write().await = build_health_from_system(&sys, docker.clone());

            let mut tick = tokio::time::interval(interval);
            // Skip the first immediate tick — we already have data above.
            tick.tick().await;

            let mut docker_tick_counter: u32 = 0;
            let mut db_sample_counter: u32 = 0;
            let mut cached_docker = docker;

            loop {
                tokio::select! {
                    _ = child_token.cancelled() => {
                        tracing::info!("health_collector: shutdown signal received");
                        break;
                    }
                    _ = tick.tick() => {}
                }

                // Refresh Docker container list every DOCKER_REFRESH_TICKS cycles.
                let (refresh_docker, docker_snapshot) = {
                    let _span = tracing::info_span!("health.collect").entered();
                    docker_tick_counter += 1;
                    let refresh_docker = docker_tick_counter >= DOCKER_REFRESH_TICKS;
                    if refresh_docker {
                        docker_tick_counter = 0;
                    }
                    (refresh_docker, cached_docker.clone())
                };

                // Move sys into a blocking thread for the refresh, then get it back.
                let (returned_sys, snapshot, updated_docker) =
                    tokio::task::spawn_blocking(move || {
                        sys.refresh_all();
                        let updated_docker = if refresh_docker {
                            detect_docker()
                        } else {
                            None
                        };
                        let effective_docker = if updated_docker.is_some() {
                            updated_docker.clone()
                        } else {
                            docker_snapshot
                        };
                        let snapshot = build_health_from_system(&sys, effective_docker);
                        (sys, snapshot, updated_docker)
                    })
                    .await
                    .unwrap_or_else(|_| (System::new(), collect_fallback(), None));

                if updated_docker.is_some() {
                    cached_docker = updated_docker;
                }

                sys = returned_sys;

                // Write health sample to DB every DB_SAMPLE_TICKS cycles (30s).
                db_sample_counter += 1;
                if db_sample_counter >= DB_SAMPLE_TICKS {
                    db_sample_counter = 0;
                    if let Some(ref db) = db {
                        let (disk_used_gb, disk_total_gb) =
                            snapshot.disk.iter().fold((0f64, 0f64), |(u, t), d| {
                                (
                                    u + d.used_bytes as f64 / 1_073_741_824.0,
                                    t + d.total_bytes as f64 / 1_073_741_824.0,
                                )
                            });
                        let record = HealthSampleRecord {
                            timestamp: chrono::Utc::now().to_rfc3339(),
                            cpu_percent: Some(snapshot.cpu.overall_percent as f64),
                            memory_used_gb: Some(snapshot.ram.used_bytes as f64 / 1_073_741_824.0),
                            memory_total_gb: Some(
                                snapshot.ram.total_bytes as f64 / 1_073_741_824.0,
                            ),
                            disk_used_gb: Some(disk_used_gb),
                            disk_total_gb: Some(disk_total_gb),
                            load1: Some(snapshot.cpu.load_average[0] as f64),
                            load5: Some(snapshot.cpu.load_average[1] as f64),
                            load15: Some(snapshot.cpu.load_average[2] as f64),
                            uptime_seconds: Some(snapshot.uptime_seconds as i64),
                        };
                        if let Err(e) = db.insert_health_sample(&record) {
                            tracing::warn!("health sample insert failed, retrying: {}", e);
                            std::thread::sleep(Duration::from_secs(1));
                            if let Err(e2) = db.insert_health_sample(&record) {
                                tracing::warn!("health sample insert failed after retry: {}", e2);
                            }
                        }
                    }
                }

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
fn build_health_from_system(sys: &System, docker: Option<DockerHealth>) -> MachineHealth {
    let overall_percent = sys.global_cpu_usage();
    let per_core_percent = sys.cpus().iter().map(|c| c.cpu_usage()).collect();

    let la = System::load_average();
    let load_average = [la.one as f32, la.five as f32, la.fifteen as f32];

    let ram_total = sys.total_memory();
    let ram_used = sys.used_memory();
    let ram_percent = if ram_total > 0 {
        (ram_used as f32 / ram_total as f32) * 100.0
    } else {
        0.0
    };

    let disks = {
        let disk_list = sysinfo::Disks::new_with_refreshed_list();
        disk_list
            .list()
            .iter()
            .map(|d| {
                let total = d.total_space();
                let used = total.saturating_sub(d.available_space());
                let pct = if total > 0 {
                    (used as f32 / total as f32) * 100.0
                } else {
                    0.0
                };
                DiskHealth {
                    mount: d.mount_point().to_string_lossy().to_string(),
                    total_bytes: total,
                    used_bytes: used,
                    percent: pct,
                }
            })
            .collect()
    };

    let hostname = System::host_name().unwrap_or_else(|| "unknown".to_string());
    let uptime_seconds = System::uptime();

    MachineHealth {
        hostname,
        uptime_seconds,
        cpu: CpuHealth {
            overall_percent,
            per_core_percent,
            load_average,
        },
        ram: RamHealth {
            total_bytes: ram_total,
            used_bytes: ram_used,
            percent: ram_percent,
        },
        disk: disks,
        docker,
    }
}

/// Fallback snapshot when spawn_blocking panics.
fn collect_fallback() -> MachineHealth {
    MachineHealth::default()
}

/// Detect running Docker containers by shelling out to `docker ps`.
///
/// Returns `None` if Docker is not installed or the command fails.
fn detect_docker() -> Option<DockerHealth> {
    let output = std::process::Command::new("docker")
        .args(["ps", "--format", "{{json .}}"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("docker ps command failed to execute: {}", e);
            return None;
        }
    };

    if !output.status.success() {
        tracing::warn!(
            "docker ps returned non-zero exit code: {}",
            output.status.code().unwrap_or(-1)
        );
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut total: u32 = 0;
    let mut running: u32 = 0;

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            total += 1;
            let is_running = value
                .get("State")
                .and_then(|v| v.as_str())
                .is_some_and(|s| s == "running");
            if is_running {
                running += 1;
            }
        }
    }

    Some(DockerHealth {
        containers: total,
        running,
    })
}
