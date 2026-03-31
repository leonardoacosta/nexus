//! Unix socket listener for local notification delivery.

use crate::services::receiver::service::{ReceiverService, SpeakRequest};
use crate::services::receiver::state::ReceiverState;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
#[cfg(unix)]
use tokio::net::UnixListener;
use tokio::sync::RwLock;
use tracing::{debug, error, warn};

impl ReceiverService {
    /// Handle a single newline-delimited JSON message received via Unix socket.
    #[cfg(unix)]
    pub(crate) async fn handle_socket_message(line: &str, state: Arc<RwLock<ReceiverState>>) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }

        match serde_json::from_str::<SpeakRequest>(trimmed) {
            Ok(req) => {
                debug!("Socket message received: {:?}", req.message);
                let body = trimmed.as_bytes();
                let _ = Self::handle_request("POST", "/speak", body, state).await;
            }
            Err(e) => {
                warn!("Invalid JSON on socket: {}", e);
            }
        }
    }

    /// Accept connections on a Unix domain socket and read newline-delimited JSON.
    #[cfg(unix)]
    pub(crate) async fn run_socket_listener(
        listener: UnixListener,
        state: Arc<RwLock<ReceiverState>>,
    ) {
        use tokio::io::BufReader as TokioBufReader;

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let state = Arc::clone(&state);
                    tokio::spawn(async move {
                        let reader = TokioBufReader::new(stream);
                        let mut lines = reader.lines();
                        loop {
                            match lines.next_line().await {
                                Ok(Some(line)) => {
                                    Self::handle_socket_message(&line, Arc::clone(&state)).await;
                                }
                                Ok(None) => break,
                                Err(e) => {
                                    debug!(
                                        "Socket read error (client may have disconnected): {}",
                                        e
                                    );
                                    break;
                                }
                            }
                        }
                    });
                }
                Err(e) => {
                    error!("Failed to accept socket connection: {}", e);
                }
            }
        }
    }
}
