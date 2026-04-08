//! iMessage notification delivery (macOS only)
//!
//! Sends iMessage notifications via AppleScript on macOS.
//! Non-macOS platforms get a no-op stub.

/// Send iMessage notification (macOS only).
#[cfg(target_os = "macos")]
pub async fn send_imessage(recipient: &str, message: &str) -> bool {
    use tokio::process::Command;
    use tracing::{info, warn};
    let script = format!(
        r#"tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "{}" of targetService
    send "{}" to targetBuddy
end tell"#,
        recipient.replace('"', "\\\""),
        message.replace('"', "\\\"")
    );

    match Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            info!("Sent iMessage to {}: {}", recipient, message);
            true
        }
        Ok(output) => {
            warn!(
                "iMessage failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            false
        }
        Err(e) => {
            warn!("Failed to execute iMessage AppleScript: {}", e);
            false
        }
    }
}

/// Send iMessage - stub for non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub async fn send_imessage(_recipient: &str, _message: &str) -> bool {
    tracing::debug!("iMessage not supported on this platform");
    false
}
