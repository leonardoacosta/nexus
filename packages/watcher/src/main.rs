//! nexus-watcher — Standalone file watcher for Claude Code session detection.
//!
//! Watches `~/.claude/projects/*/sessions.json` for changes and emits session
//! lifecycle events (start/update/end) as newline-delimited JSON on stdout.
//! Receives control messages (watch, shutdown) as newline-delimited JSON on stdin.
//!
//! Designed to be spawned as a subprocess by the Bun agent, communicating
//! exclusively via stdin/stdout IPC.

mod ipc;
mod watcher;

use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};
use tracing::info;

use ipc::OutboundMessage;
use watcher::SessionState;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    // Send tracing logs to stderr so they don't pollute the JSON IPC on stdout.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_target(false)
        .init();

    info!("nexus-watcher starting");

    let state = Arc::new(RwLock::new(SessionState::default()));
    let (outbound_tx, outbound_rx) = mpsc::channel::<OutboundMessage>(256);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    // Spawn the stdout writer.
    let writer_handle = tokio::spawn(ipc::stdout_writer(outbound_rx));

    // Spawn the stdin reader — it processes inbound commands and may spawn
    // file watchers that feed events into outbound_tx.
    let stdin_outbound_tx = outbound_tx.clone();
    let stdin_state = state.clone();
    let _reader_handle = tokio::spawn(ipc::stdin_reader(
        stdin_outbound_tx,
        stdin_state,
        shutdown_tx,
    ));

    // Wait for shutdown signal (from stdin "shutdown" command or process signal).
    let signal_shutdown = async {
        #[cfg(unix)]
        {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to register SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c()
                .await
                .expect("failed to register Ctrl-C handler");
        }
    };

    tokio::select! {
        _ = signal_shutdown => {
            info!("received signal, shutting down");
        }
        _ = shutdown_rx.recv() => {
            info!("received shutdown command via stdin");
        }
    }

    // Drop our outbound sender so the writer task can drain and exit.
    drop(outbound_tx);

    // Wait for writer to flush remaining messages (with a timeout to avoid
    // hanging if a spawned task still holds a sender clone).
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer_handle).await;

    info!("nexus-watcher stopped");

    // Exit explicitly. The stdin reader may be blocked on a syscall that
    // tokio::abort cannot interrupt (blocking thread pool for stdin I/O).
    // This is safe because all important state has been flushed above.
    std::process::exit(0);
}
