use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "nexus-register", about = "Register CC sessions with nexus-agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Register a new ad-hoc session
    Start {
        #[arg(long)]
        session_id: String,
        #[arg(long)]
        pid: u32,
        #[arg(long)]
        cwd: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        branch: Option<String>,
    },
    /// Unregister a session
    Stop {
        #[arg(long)]
        session_id: String,
    },
    /// Send heartbeat for a session
    Heartbeat {
        #[arg(long)]
        session_id: String,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();
    // All errors are silently swallowed - exit 0 always
    let _ = run(cli).await;
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    use nexus_core::proto::nexus_agent_client::NexusAgentClient;
    use std::time::Duration;
    use tonic::transport::Endpoint;

    let endpoint = Endpoint::from_static("http://localhost:7400")
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(1));

    let mut client = NexusAgentClient::connect(endpoint).await?;

    match cli.command {
        Command::Start {
            session_id,
            pid,
            cwd,
            project,
            branch,
        } => {
            client
                .register_session(nexus_core::proto::RegisterSessionRequest {
                    session_id,
                    pid,
                    cwd,
                    project,
                    branch,
                    command: None,
                })
                .await?;
        }
        Command::Stop { session_id } => {
            client
                .unregister_session(nexus_core::proto::UnregisterSessionRequest { session_id })
                .await?;
        }
        Command::Heartbeat { session_id } => {
            client
                .heartbeat(nexus_core::proto::HeartbeatRequest { session_id })
                .await?;
        }
    }

    Ok(())
}
