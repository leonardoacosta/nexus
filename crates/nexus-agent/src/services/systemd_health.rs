//! SystemD Health Reporter Service
//!
//! Reports daemon health back to systemd via the sd_notify protocol.
//! Only active when the `NOTIFY_SOCKET` environment variable is set
//! (i.e., running under a systemd service with Type=notify or WatchdogSec).
//!
//! Protocol:
//! - On start: sends `READY=1` to signal service readiness
//! - Periodic: sends `WATCHDOG=1` heartbeat at configured interval
//! - On shutdown: sends `STOPPING=1`
//!
//! Uses raw Unix datagram socket writes -- no libsystemd dependency.

use crate::services::Service;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Send a notification to a specific socket path (core logic, no env var access).
///
/// Supports both filesystem and abstract sockets (prefixed with `@`).
fn sd_notify_to(socket_path: &str, state: &str) -> Result<()> {
    let socket = std::os::unix::net::UnixDatagram::unbound()
        .map_err(|e| anyhow::anyhow!("Failed to create Unix datagram socket: {}", e))?;

    if socket_path.starts_with('@') {
        // Abstract socket: replace leading '@' with null byte
        let abstract_name = format!("\0{}", &socket_path[1..]);
        socket
            .send_to(state.as_bytes(), abstract_name.as_str())
            .map_err(|e| anyhow::anyhow!("Failed to send to abstract socket: {}", e))?;
    } else {
        socket
            .send_to(state.as_bytes(), socket_path)
            .map_err(|e| anyhow::anyhow!("Failed to send to socket {}: {}", socket_path, e))?;
    }

    Ok(())
}

/// Read NOTIFY_SOCKET from environment. Returns None if unset or empty.
fn get_notify_socket() -> Option<String> {
    match std::env::var("NOTIFY_SOCKET") {
        Ok(path) if !path.is_empty() => Some(path),
        _ => None,
    }
}

/// Send a notification string to systemd via the `NOTIFY_SOCKET`.
///
/// Returns `Ok(true)` if the message was sent, `Ok(false)` if `NOTIFY_SOCKET`
/// is not set (not running under systemd), or `Err` on socket errors.
fn sd_notify(state: &str) -> Result<bool> {
    match get_notify_socket() {
        Some(path) => {
            sd_notify_to(&path, state)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Check if a socket path string represents a valid notify socket configuration.
pub fn is_valid_notify_socket(socket_path: &str) -> bool {
    !socket_path.is_empty()
}

/// SystemD health reporter service.
///
/// Sends sd_notify protocol messages so systemd knows the daemon is alive.
/// Gracefully no-ops when not running under systemd.
pub struct SystemdHealthService {
    /// Interval in seconds between watchdog heartbeats.
    interval_secs: u64,
    /// Tracks whether the service is running.
    healthy: Arc<AtomicBool>,
}

impl SystemdHealthService {
    /// Create a new systemd health service with the given watchdog interval.
    pub fn new(interval_secs: u64) -> Self {
        Self {
            interval_secs,
            healthy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Check whether NOTIFY_SOCKET is set (i.e., running under systemd).
    pub fn is_systemd_managed() -> bool {
        get_notify_socket().is_some()
    }
}

#[async_trait::async_trait]
impl Service for SystemdHealthService {
    fn name(&self) -> &'static str {
        "systemd-health"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        if !Self::is_systemd_managed() {
            info!("SystemD health service: NOTIFY_SOCKET not set, service inactive");
            // Still listen for shutdown even though we're not doing anything,
            // so the daemon shutdown sequence completes cleanly.
            let _ = shutdown_rx.recv().await;
            return Ok(());
        }

        info!(
            "SystemD health service starting (watchdog interval={}s)",
            self.interval_secs
        );

        // Signal readiness to systemd
        match sd_notify("READY=1") {
            Ok(true) => info!("Sent READY=1 to systemd"),
            Ok(false) => warn!("NOTIFY_SOCKET disappeared before READY could be sent"),
            Err(e) => error!("Failed to send READY=1 to systemd: {}", e),
        }

        self.healthy.store(true, Ordering::SeqCst);

        let mut interval =
            tokio::time::interval(std::time::Duration::from_secs(self.interval_secs));

        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("SystemD health service shutting down");
                    break;
                }
                _ = interval.tick() => {
                    match sd_notify("WATCHDOG=1") {
                        Ok(true) => debug!("Sent WATCHDOG=1 to systemd"),
                        Ok(false) => {
                            warn!("NOTIFY_SOCKET no longer set, stopping watchdog");
                            break;
                        }
                        Err(e) => {
                            warn!("Failed to send WATCHDOG=1: {}", e);
                            // Continue trying -- transient failures shouldn't kill the service
                        }
                    }
                }
            }
        }

        // Signal stopping to systemd
        match sd_notify("STOPPING=1") {
            Ok(true) => info!("Sent STOPPING=1 to systemd"),
            Ok(false) => {
                debug!("NOTIFY_SOCKET not set during shutdown (expected if not under systemd)")
            }
            Err(e) => warn!("Failed to send STOPPING=1 to systemd: {}", e),
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

    #[test]
    fn test_systemd_health_service_new() {
        let service = SystemdHealthService::new(30);
        assert_eq!(service.interval_secs, 30);
        assert_eq!(service.name(), "systemd-health");
    }

    #[tokio::test]
    async fn test_systemd_health_check_before_start() {
        let service = SystemdHealthService::new(30);
        assert!(!service.health_check().await);
    }

    #[test]
    fn test_is_valid_notify_socket() {
        assert!(is_valid_notify_socket("/run/systemd/notify"));
        assert!(is_valid_notify_socket("@/org/freedesktop/systemd1/notify"));
        assert!(!is_valid_notify_socket(""));
    }

    #[test]
    fn test_sd_notify_to_nonexistent_path() {
        // Sending to a path where nothing is listening should fail
        let result = sd_notify_to("/tmp/nonexistent-sd-notify-test-socket-99999", "READY=1");
        assert!(result.is_err());
    }

    #[test]
    fn test_sd_notify_to_real_socket() {
        // Create a temporary Unix datagram socket and verify we can send to it
        let tmp_dir = tempfile::TempDir::new().expect("should create temp dir");
        let socket_path = tmp_dir.path().join("test-notify.sock");

        // Create a listening socket
        let listener =
            std::os::unix::net::UnixDatagram::bind(&socket_path).expect("should bind test socket");
        listener
            .set_nonblocking(true)
            .expect("should set nonblocking");

        // Send a message
        let result = sd_notify_to(socket_path.to_str().expect("valid utf8"), "READY=1");
        assert!(
            result.is_ok(),
            "Should successfully send to listening socket"
        );

        // Verify the message was received
        let mut buf = [0u8; 256];
        let len = listener.recv(&mut buf).expect("should receive message");
        assert_eq!(&buf[..len], b"READY=1");
    }

    #[test]
    fn test_sd_notify_to_watchdog_message() {
        let tmp_dir = tempfile::TempDir::new().expect("should create temp dir");
        let socket_path = tmp_dir.path().join("test-watchdog.sock");

        let listener =
            std::os::unix::net::UnixDatagram::bind(&socket_path).expect("should bind test socket");
        listener
            .set_nonblocking(true)
            .expect("should set nonblocking");

        let result = sd_notify_to(socket_path.to_str().expect("valid utf8"), "WATCHDOG=1");
        assert!(result.is_ok());

        let mut buf = [0u8; 256];
        let len = listener.recv(&mut buf).expect("should receive message");
        assert_eq!(&buf[..len], b"WATCHDOG=1");
    }

    #[test]
    fn test_sd_notify_to_stopping_message() {
        let tmp_dir = tempfile::TempDir::new().expect("should create temp dir");
        let socket_path = tmp_dir.path().join("test-stopping.sock");

        let listener =
            std::os::unix::net::UnixDatagram::bind(&socket_path).expect("should bind test socket");
        listener
            .set_nonblocking(true)
            .expect("should set nonblocking");

        let result = sd_notify_to(socket_path.to_str().expect("valid utf8"), "STOPPING=1");
        assert!(result.is_ok());

        let mut buf = [0u8; 256];
        let len = listener.recv(&mut buf).expect("should receive message");
        assert_eq!(&buf[..len], b"STOPPING=1");
    }

    #[tokio::test]
    async fn test_systemd_health_service_shutdown() {
        // Test that the service shuts down cleanly regardless of NOTIFY_SOCKET state.
        // We use a long interval so the watchdog tick never fires during the test.
        let service = SystemdHealthService::new(3600);
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let handle = tokio::spawn(async move { service.start(shutdown_rx).await });

        // Give it time to start
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Send shutdown
        let _ = shutdown_tx.send(()).await;

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;

        assert!(result.is_ok(), "Service should shut down within timeout");
    }
}
