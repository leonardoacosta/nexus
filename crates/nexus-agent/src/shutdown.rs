use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio_util::sync::CancellationToken;

pub struct ShutdownCoordinator {
    token: CancellationToken,
    active_streams: Arc<AtomicUsize>,
}

impl ShutdownCoordinator {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            active_streams: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn active_streams(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.active_streams)
    }

    pub fn stream_count(&self) -> usize {
        self.active_streams.load(Ordering::Relaxed)
    }

    pub fn initiate_shutdown(&self) {
        let count = self.stream_count();
        tracing::info!("shutdown initiated, draining {count} active streams");
        self.token.cancel();
    }

    pub async fn wait_for_drain(&self, timeout: std::time::Duration) {
        let start = std::time::Instant::now();
        while self.stream_count() > 0 && start.elapsed() < timeout {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let remaining = self.stream_count();
        if remaining > 0 {
            tracing::warn!("drain timeout with {remaining} streams still active");
        } else {
            tracing::info!("all streams drained cleanly");
        }
    }
}
