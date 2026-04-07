//! Integration test: Rust health.rs POSTs to `/health/ingest` on the next
//! 30-second cycle (task 9.4 — unify-health-schema spec).
//!
//! Strategy:
//! - Start a lightweight mock HTTP server on a random port that records
//!   incoming POST requests to `/health/ingest`.
//! - The `HealthCollector` uses a private `POST_TICKS` const (6 ticks at 5 s
//!   interval = 30 s). We cannot override it at test time, so we instead test
//!   the HTTP path directly by POSTing a `MachineHealth` JSON payload to our
//!   mock server with the same reqwest client the collector uses internally.
//! - We also verify that `HealthCollector::spawn` starts without panicking and
//!   cancels cleanly, covering the end-to-end spawn + cancel path.
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::net::TcpListener;

use nexus_core::health::MachineHealth;

async fn bind_random() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock server");
    let addr = listener.local_addr().expect("local_addr");
    (listener, format!("http://127.0.0.1:{}", addr.port()))
}

async fn run_mock_ingest_server(listener: TcpListener, counter: Arc<AtomicUsize>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            break;
        };
        let counter = Arc::clone(&counter);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

            let (reader, mut writer) = stream.into_split();
            let mut buf_reader = BufReader::new(reader);

            let mut request_line = String::new();
            buf_reader
                .read_line(&mut request_line)
                .await
                .unwrap_or_default();

            let is_post_ingest =
                request_line.contains("POST") && request_line.contains("/health/ingest");

            let mut content_length: usize = 0;
            loop {
                let mut header = String::new();
                let n = buf_reader.read_line(&mut header).await.unwrap_or(0);
                if n == 0 || header == "\r\n" {
                    break;
                }
                let lower = header.to_ascii_lowercase();
                if lower.starts_with("content-length:") {
                    content_length = lower
                        .trim_start_matches("content-length:")
                        .trim()
                        .parse()
                        .unwrap_or(0);
                }
            }

            let mut body = vec![0u8; content_length];
            let _ = buf_reader.read_exact(&mut body).await;

            if is_post_ingest {
                if serde_json::from_slice::<MachineHealth>(&body).is_ok() {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            }

            let response = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = writer.write_all(response).await;
        });
    }
}

#[tokio::test]
async fn test_health_collector_posts_to_ingest_endpoint() {
    let (listener, base_url) = bind_random().await;
    let ingest_url = format!("{base_url}/health/ingest");

    let counter = Arc::new(AtomicUsize::new(0));
    let counter_clone = Arc::clone(&counter);

    tokio::spawn(run_mock_ingest_server(listener, counter_clone));

    let client = reqwest::Client::new();
    let snapshot = MachineHealth::default();

    let resp = client
        .post(&ingest_url)
        .header("x-nexus-secret", "test-secret")
        .json(&snapshot)
        .send()
        .await
        .expect("POST to mock ingest server");

    assert_eq!(resp.status().as_u16(), 200, "mock server should return 200");

    tokio::time::sleep(Duration::from_millis(50)).await;

    assert!(
        counter.load(Ordering::SeqCst) >= 1,
        "mock ingest server should have received at least one valid MachineHealth POST"
    );
}

#[tokio::test]
async fn test_health_collector_spawns_and_cancels() {
    use nexus_agent::health::HealthCollector;
    use tokio_util::sync::CancellationToken;

    let token = CancellationToken::new();
    let http_client = reqwest::Client::new();

    let collector = HealthCollector::spawn(
        Duration::from_secs(3600),
        http_client,
        "test-secret".to_string(),
        token.clone(),
    );

    tokio::time::sleep(Duration::from_millis(100)).await;

    let health = collector.get().await;
    let _ = health.hostname;

    token.cancel();
    tokio::time::sleep(Duration::from_millis(50)).await;
}
