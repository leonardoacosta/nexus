use anyhow::Result;
use tokio_util::sync::CancellationToken;

/// Trait all nexus-agent services must implement.
///
/// Adapted from claude-daemon's Service trait — shutdown signaling uses
/// CancellationToken instead of mpsc::Receiver<()> to match nexus-agent's
/// existing ShutdownCoordinator pattern.
#[async_trait::async_trait]
pub trait Service: Send + Sync {
    /// Service name for logging.
    fn name(&self) -> &'static str;

    /// Start the service. Runs until the cancellation token is cancelled.
    async fn start(&self, shutdown: CancellationToken) -> Result<()>;

    /// Check if service is healthy.
    async fn health_check(&self) -> bool {
        true
    }
}

pub mod credential_watcher;
pub mod git_watch;
pub mod receiver;
pub mod sync_telemetry;

#[cfg(target_os = "linux")]
pub mod server_monitor;
#[cfg(target_os = "linux")]
pub mod systemd_health;

pub mod launchd_health;
pub mod macos_integration;
pub mod imessage_reader;