//! Tmux command dispatch — send answer text to a Claude Code session pane.
//!
//! Used by the bidirectional routing feature to relay iMessage answers
//! (or answers received via the socket `Answer` event) back into a running
//! CC session by simulating keyboard input via `tmux send-keys`.

use anyhow::{Context, Result};
use tracing::{debug, info, warn};

/// Send `text` as keyboard input to the tmux pane identified by `target`.
///
/// `target` follows the standard tmux addressing syntax, e.g.:
///   - `"main:0.1"` — window 0, pane 1 of session "main"
///   - `"%12"` — pane by its unique pane ID
///
/// The text is shell-escaped before being passed to `tmux send-keys` to
/// prevent accidental command injection from answer content.
///
/// After the text, `Enter` is sent so CC sees the input immediately.
pub async fn dispatch_answer(target: &str, text: &str) -> Result<()> {
    // Verify that a tmux server is running and the target pane exists before
    // attempting to send input.
    verify_pane_exists(target).await?;

    // Escape the text for safe use as a tmux send-keys argument.
    let escaped = escape_for_tmux(text);

    info!(target = %target, text_len = text.len(), "dispatching answer to tmux pane");

    let status = tokio::process::Command::new("tmux")
        .args(["send-keys", "-t", target, &escaped, "Enter"])
        .status()
        .await
        .context("failed to execute tmux send-keys")?;

    if status.success() {
        debug!(target = %target, "answer dispatched successfully");
        Ok(())
    } else {
        anyhow::bail!(
            "tmux send-keys exited with non-zero status {} for target {:?}",
            status,
            target
        )
    }
}

/// Verify that the pane `target` exists in the running tmux server.
///
/// Returns `Err` if tmux is not running, the server is unreachable, or the
/// specified pane/window/session does not exist.
async fn verify_pane_exists(target: &str) -> Result<()> {
    let output = tokio::process::Command::new("tmux")
        .args(["display-message", "-t", target, "-p", "#{pane_id}"])
        .output()
        .await
        .context("failed to execute tmux display-message (is tmux running?)")?;

    if output.status.success() {
        let pane_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        debug!(target = %target, pane_id = %pane_id, "tmux pane verified");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        warn!(target = %target, error = %stderr, "tmux pane not found");
        anyhow::bail!("tmux pane {:?} does not exist: {}", target, stderr)
    }
}

/// Escape `text` so it can be safely passed as a `tmux send-keys` argument.
///
/// `tmux send-keys` interprets special key names (e.g. `Enter`, `Escape`)
/// when they appear as standalone tokens. We quote the entire string to
/// prevent that, and escape any embedded single-quotes.
///
/// Strategy: wrap in single-quotes and escape internal `'` as `'"'"'`.
fn escape_for_tmux(text: &str) -> String {
    // Replace each single-quote with: end-quote ' end-single-quote " single-quote " start-quote '
    let inner = text.replace('\'', r#"'"'"'"#);
    format!("'{inner}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_plain_text() {
        assert_eq!(escape_for_tmux("hello world"), "'hello world'");
    }

    #[test]
    fn escape_with_single_quote() {
        // Input:    it's fine
        // Expected: 'it'"'"'s fine'
        assert_eq!(escape_for_tmux("it's fine"), r#"'it'"'"'s fine'"#);
    }

    #[test]
    fn escape_empty() {
        assert_eq!(escape_for_tmux(""), "''");
    }

    #[test]
    fn escape_key_name_is_quoted() {
        // Without quoting, "Enter" would be sent as the Enter key by tmux.
        // With quoting it is sent as the literal string "Enter".
        assert_eq!(escape_for_tmux("Enter"), "'Enter'");
    }
}
