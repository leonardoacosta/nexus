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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineHealth {
    pub hostname: String,
    pub uptime_seconds: u64,
    pub cpu: CpuHealth,
    pub ram: RamHealth,
    pub disk: Vec<DiskHealth>,
    pub docker: Option<DockerHealth>,
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
