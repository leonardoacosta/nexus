//! Integration test: spawn the watcher binary, send commands via stdin,
//! create test files, and verify session events appear on stdout.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Find the watcher binary path. Prefer debug build.
fn watcher_binary() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let debug_path = format!("{}/../../target/debug/nexus-watcher", manifest_dir);
    if Path::new(&debug_path).exists() {
        return debug_path;
    }
    // Fall back to release
    let release_path = format!("{}/../../target/release/nexus-watcher", manifest_dir);
    if Path::new(&release_path).exists() {
        return release_path;
    }
    // Fall back to the standalone target directory
    let standalone_debug = format!("{}/target/debug/nexus-watcher", manifest_dir);
    if Path::new(&standalone_debug).exists() {
        return standalone_debug;
    }
    panic!(
        "nexus-watcher binary not found. Run `cargo build --manifest-path packages/watcher/Cargo.toml` first."
    );
}

/// Read a single JSON line from the reader with a timeout.
async fn read_json_line(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    timeout_dur: Duration,
) -> Option<Value> {
    let mut line = String::new();
    match tokio::time::timeout(timeout_dur, reader.read_line(&mut line)).await {
        Ok(Ok(n)) if n > 0 => serde_json::from_str(line.trim()).ok(),
        _ => None,
    }
}

#[tokio::test]
async fn test_watch_and_detect_session() {
    let tmp = TempDir::new().expect("create temp dir");
    let watch_dir = tmp.path().to_path_buf();

    // Create a project subdirectory (simulating ~/.claude/projects/<project>/).
    let project_dir = watch_dir.join("test-project");
    std::fs::create_dir_all(&project_dir).expect("create project dir");

    let binary = watcher_binary();

    // Spawn the watcher with RUST_LOG=debug for visibility.
    let mut child = Command::new(&binary)
        .env("RUST_LOG", "debug")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn watcher");

    let mut stdin = child.stdin.take().expect("no stdin");
    let stdout = child.stdout.take().expect("no stdout");
    let mut reader = BufReader::new(stdout);

    // Give the process a moment to start up.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Send a watch command.
    let watch_cmd = format!(
        r#"{{"type":"watch","paths":["{}"]}}"#,
        watch_dir.display()
    );
    stdin
        .write_all(format!("{}\n", watch_cmd).as_bytes())
        .await
        .expect("write watch command");
    stdin.flush().await.expect("flush stdin");

    // Read the watch_ack response.
    let ack = read_json_line(&mut reader, Duration::from_secs(5)).await;
    assert!(ack.is_some(), "expected watch_ack response");
    let ack = ack.unwrap();
    assert_eq!(ack["type"], "watch_ack");

    // Give the watcher time to set up inotify.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Create a sessions.json file with one session.
    let sessions_path = project_dir.join("sessions.json");
    std::fs::write(
        &sessions_path,
        r#"[{"session_id": "test-session-001"}]"#,
    )
    .expect("write sessions.json");

    // Read the session_start event.
    let event = read_json_line(&mut reader, Duration::from_secs(5)).await;
    assert!(event.is_some(), "expected session_start event");
    let event = event.unwrap();
    assert_eq!(event["type"], "session_start");
    assert_eq!(event["session_id"], "test-session-001");

    // Update the sessions.json file to trigger a session_update.
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::write(
        &sessions_path,
        r#"[{"session_id": "test-session-001"}]"#,
    )
    .expect("rewrite sessions.json");

    let event = read_json_line(&mut reader, Duration::from_secs(5)).await;
    assert!(event.is_some(), "expected session_update event");
    let event = event.unwrap();
    assert_eq!(event["type"], "session_update");
    assert_eq!(event["session_id"], "test-session-001");

    // Remove the session from the file to trigger session_end.
    tokio::time::sleep(Duration::from_millis(300)).await;
    std::fs::write(&sessions_path, "[]").expect("write empty sessions.json");

    let event = read_json_line(&mut reader, Duration::from_secs(5)).await;
    assert!(event.is_some(), "expected session_end event");
    let event = event.unwrap();
    assert_eq!(event["type"], "session_end");
    assert_eq!(event["session_id"], "test-session-001");

    // Send shutdown command.
    stdin
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .await
        .expect("write shutdown");
    stdin.flush().await.expect("flush shutdown");

    // Wait for the process to exit.
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("watcher should exit within timeout")
        .expect("wait failed");

    assert!(
        status.success(),
        "watcher exited with non-zero status: {}",
        status
    );
}

#[tokio::test]
async fn test_shutdown_via_stdin() {
    let binary = watcher_binary();

    let mut child = Command::new(&binary)
        .env("RUST_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn watcher");

    let mut stdin = child.stdin.take().expect("no stdin");

    // Give it a moment to start.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Send shutdown.
    stdin
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .await
        .expect("write shutdown");
    stdin.flush().await.expect("flush");

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("should exit within timeout")
        .expect("wait failed");

    assert!(status.success(), "expected clean exit, got: {}", status);
}

#[tokio::test]
async fn test_shutdown_via_eof() {
    let binary = watcher_binary();

    let mut child = Command::new(&binary)
        .env("RUST_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn watcher");

    // Drop stdin to send EOF.
    drop(child.stdin.take());

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("should exit within timeout")
        .expect("wait failed");

    assert!(status.success(), "expected clean exit, got: {}", status);
}

#[tokio::test]
async fn test_invalid_message_returns_error() {
    let binary = watcher_binary();

    let mut child = Command::new(&binary)
        .env("RUST_LOG", "warn")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn watcher");

    let mut stdin = child.stdin.take().expect("no stdin");
    let stdout = child.stdout.take().expect("no stdout");
    let mut reader = BufReader::new(stdout);

    tokio::time::sleep(Duration::from_millis(200)).await;

    // Send invalid JSON.
    stdin
        .write_all(b"this is not json\n")
        .await
        .expect("write invalid");
    stdin.flush().await.expect("flush");

    // Should get an error response.
    let event = read_json_line(&mut reader, Duration::from_secs(3)).await;
    assert!(event.is_some(), "expected error response");
    let event = event.unwrap();
    assert_eq!(event["type"], "error");

    // Clean up.
    stdin
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .await
        .expect("write shutdown");
    stdin.flush().await.expect("flush");

    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}
