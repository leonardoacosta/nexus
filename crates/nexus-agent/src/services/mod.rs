use anyhow::Result;
use tokio::sync::mpsc;

/// Trait all services must implement.
///
/// Matches claude-daemon's Service trait. Shutdown signaling uses
/// mpsc::Receiver<()>; callers bridge from CancellationToken by
/// sending () on the channel when the token is cancelled.
#[async_trait::async_trait]
pub trait Service: Send + Sync {
    /// Service name for logging.
    fn name(&self) -> &'static str;

    /// Start the service. Runs until a message is received on `shutdown_rx`.
    async fn start(&self, shutdown_rx: mpsc::Receiver<()>) -> Result<()>;

    /// Check if service is healthy.
    async fn health_check(&self) -> bool {
        true
    }
}

pub mod credential_watcher;
pub mod git_watch;
pub mod imessage_reader;
pub mod launchd_health;
pub mod macos_integration;
pub mod receiver;
pub mod sync_telemetry;

#[cfg(target_os = "linux")]
pub mod server_monitor;
#[cfg(target_os = "linux")]
pub mod systemd_health;
