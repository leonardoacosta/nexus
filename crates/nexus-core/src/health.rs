use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuHealth {
    pub overall_percent: f32,
    pub per_core_percent: Vec<f32>,
    pub load_average: [f32; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RamHealth {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskHealth {
    pub mount: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub percent: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerHealth {
    pub containers: u32,
    pub running: u32,
}

/// A single network interface with traffic counters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInterface {
    pub iface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// A single process entry for top-N CPU/RAM lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessEntry {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub ram_percent: f32,
}

/// Snapshot of top processes by CPU and RAM usage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessSnapshot {
    pub top_cpu: Vec<ProcessEntry>,
    pub top_ram: Vec<ProcessEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineHealth {
    pub hostname: String,
    pub uptime_seconds: u64,
    pub cpu: CpuHealth,
    pub ram: RamHealth,
    pub disk: Vec<DiskHealth>,
    pub docker: Option<DockerHealth>,
    pub network: Option<Vec<NetworkInterface>>,
    pub processes: Option<ProcessSnapshot>,
    pub collected_at: Option<DateTime<Utc>>,
}

impl Default for MachineHealth {
    fn default() -> Self {
        Self {
            hostname: String::new(),
            uptime_seconds: 0,
            cpu: CpuHealth {
                overall_percent: 0.0,
                per_core_percent: Vec::new(),
                load_average: [0.0; 3],
            },
            ram: RamHealth {
                total_bytes: 0,
                used_bytes: 0,
                percent: 0.0,
            },
            disk: Vec::new(),
            docker: None,
            network: None,
            processes: None,
            collected_at: None,
        }
    }
}

/// Legacy container status type — kept for any code that still parses
/// the old `docker ps` JSON format.  New code uses `DockerHealth`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContainerStatus {
    pub name: String,
    pub running: bool,
}
