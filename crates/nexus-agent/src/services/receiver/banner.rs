//! macOS Notification Center banner delivery via osascript
//!
//! Executes `osascript -e 'display notification "message" with title "title"'`
//! to show a native macOS banner. On non-macOS platforms, this is a silent no-op
//! detected at runtime via `std::env::consts::OS`.

use tracing::{debug, info, warn};

/// Maximum banner message length before truncation.
/// macOS notification banners truncate long text; we truncate proactively
/// to keep the display clean.
const BANNER_MAX_CHARS: usize = 200;

/// macOS Notification Center banner delivery
pub struct BannerDelivery;

impl BannerDelivery {
    /// Deliver a macOS Notification Center banner.
    ///
    /// On non-macOS platforms, logs a debug message and returns Ok(false).
    /// On macOS, runs osascript to display the notification and returns Ok(true) on success.
    ///
    /// # Arguments
    /// * `message` - The notification body (truncated at 200 chars)
    /// * `title` - The notification title (default: "Claude")
    pub async fn deliver(message: &str, title: Option<&str>) -> Result<bool, String> {
        if std::env::consts::OS != "macos" {
            debug!(
                "Banner delivery skipped: not macOS (os={})",
                std::env::consts::OS
            );
            return Ok(false);
        }

        let title = title.unwrap_or("Claude");

        // Truncate message at BANNER_MAX_CHARS
        let display_message = if message.len() > BANNER_MAX_CHARS {
            let truncated = &message[..BANNER_MAX_CHARS];
            // Try to truncate at a word boundary
            let end = truncated.rfind(' ').unwrap_or(BANNER_MAX_CHARS);
            format!("{}...", &message[..end])
        } else {
            message.to_string()
        };

        // Escape quotes for AppleScript string
        let escaped_message = display_message.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_title = title.replace('\\', "\\\\").replace('"', "\\\"");

        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escaped_message, escaped_title
        );

        let result = tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .await;

        match result {
            Ok(output) if output.status.success() => {
                info!("Banner notification delivered: title={}", title);
                Ok(true)
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                warn!("osascript banner failed: {}", stderr);
                Err(format!("osascript failed: {}", stderr))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                warn!("osascript not found on this macOS system");
                Err("osascript not found".to_string())
            }
            Err(e) => {
                warn!("Banner delivery error: {}", e);
                Err(format!("osascript error: {}", e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_banner_max_chars_constant() {
        assert_eq!(BANNER_MAX_CHARS, 200);
    }

    #[tokio::test]
    async fn test_banner_delivery_non_macos() {
        // On Linux (this machine), banner delivery should be a no-op returning Ok(false)
        if std::env::consts::OS != "macos" {
            let result = BannerDelivery::deliver("Test message", Some("Test Title")).await;
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), false);
        }
    }

    #[tokio::test]
    async fn test_banner_delivery_default_title() {
        if std::env::consts::OS != "macos" {
            let result = BannerDelivery::deliver("Test message", None).await;
            assert!(result.is_ok());
            assert_eq!(result.unwrap(), false);
        }
    }
}
