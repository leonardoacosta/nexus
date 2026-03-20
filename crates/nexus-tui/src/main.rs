use anyhow::Result;

mod app;
mod screens;
mod client;

#[tokio::main]
async fn main() -> Result<()> {
    // TODO: Load config from ~/.config/nexus/agents.toml
    // TODO: Initialize agent client (HTTP poller)
    // TODO: Start ratatui event loop
    // TODO: Render screens based on app state

    Ok(())
}
