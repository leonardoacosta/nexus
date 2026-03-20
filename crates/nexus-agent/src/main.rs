use anyhow::Result;
use tracing_subscriber::EnvFilter;

mod registry;
mod routes;
mod watcher;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("nexus_agent=info".parse()?))
        .init();

    tracing::info!("nexus-agent starting on port 7400");

    // TODO: Initialize session registry
    // TODO: Start sessions.json file watcher
    // TODO: Start HTTP server with axum
    // TODO: Start system health monitor

    Ok(())
}
