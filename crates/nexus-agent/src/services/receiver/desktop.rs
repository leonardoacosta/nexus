//! Desktop notification delivery
//!
//! Platform-specific desktop notifications via terminal-notifier (macOS)
//! or notify-send (Linux).

use tokio::process::Command;
use tracing::{debug, info};

/// Show desktop notification using terminal-notifier (macOS) or notify-send (Linux).
pub(crate) async fn show_notification(_title: &str, message: &str, project: Option<&str>) {
    let (icon, name) = crate::claude_utils::project::get_project_display(project.unwrap_or(""));
    let full_title = format!("{} {}", icon, name);

    if cfg!(target_os = "macos") {
        // Use Nexus-Notifier.app (a copy of terminal-notifier with the NX icon
        // baked into the .app bundle). Falls back to homebrew terminal-notifier.
        let nexus_notifier = nexus_core::paths::home_dir()
            .join(".local/share/Nexus-Notifier.app/Contents/MacOS/terminal-notifier");
        let notifier_path = if nexus_notifier.exists() {
            nexus_notifier
        } else {
            std::path::PathBuf::from("/opt/homebrew/bin/terminal-notifier")
        };

        let mut cmd = Command::new(&notifier_path);
        cmd.arg("-title")
            .arg(&full_title)
            .arg("-message")
            .arg(message)
            .arg("-sound")
            .arg("default");

        let result = cmd.output().await;

        match result {
            Ok(output) if output.status.success() => {
                info!("Desktop notification sent (bell)");
            }
            Ok(output) => {
                info!(
                    "terminal-notifier failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                info!("terminal-notifier not found at /opt/homebrew/bin/terminal-notifier");
            }
            Err(e) => {
                info!("terminal-notifier error: {}", e);
            }
        }
    } else {
        let result = Command::new("notify-send")
            .arg(&full_title)
            .arg(message)
            .output()
            .await;

        match result {
            Ok(output) if output.status.success() => {
                debug!("Desktop notification sent via notify-send");
            }
            Ok(output) => {
                debug!(
                    "notify-send failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                debug!("notify-send not installed, skipping desktop notification");
            }
            Err(e) => {
                debug!("notify-send error: {}", e);
            }
        }
    }
}
