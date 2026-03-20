use std::io;

use anyhow::Result;
use crossterm::terminal::{EnterAlternateScreen, LeaveAlternateScreen};

/// Perform a full attach to a remote tmux session via SSH.
///
/// This function:
/// 1. Disables crossterm raw mode and leaves the alternate screen
/// 2. Spawns `ssh {user}@{host} -t 'tmux a -t {tmux_session}'`
/// 3. Waits for the child to exit (user detaches from tmux)
/// 4. Re-enables raw mode and enters the alternate screen
pub async fn attach_full(agent_host: &str, agent_user: &str, tmux_session: &str) -> Result<()> {
    // Leave TUI mode so the user gets a raw terminal for SSH.
    crossterm::terminal::disable_raw_mode()?;
    crossterm::execute!(io::stdout(), LeaveAlternateScreen)?;

    let tmux_cmd = format!("tmux a -t {tmux_session}");
    let status = tokio::process::Command::new("ssh")
        .arg(format!("{agent_user}@{agent_host}"))
        .arg("-t")
        .arg(&tmux_cmd)
        .status()
        .await;

    // Always restore TUI mode, even on error.
    crossterm::terminal::enable_raw_mode()?;
    crossterm::execute!(io::stdout(), EnterAlternateScreen)?;

    match status {
        Ok(exit) if exit.success() => Ok(()),
        Ok(exit) => anyhow::bail!("ssh exited with code {}", exit.code().unwrap_or(-1)),
        Err(e) => anyhow::bail!("failed to spawn ssh: {e}"),
    }
}
