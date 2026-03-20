# Nexus

Peer-to-peer terminal dashboard for managing Claude Code sessions across all your machines.

Each dev server runs a lightweight agent daemon. The TUI aggregates sessions from all agents over Tailscale, letting you monitor, stream, and attach to any Claude Code session from a single terminal.

## Features

- **Dashboard** — all sessions across all machines, grouped by project
- **Live streaming** — read-only event stream for any session (`a` to attach)
- **Full attach** — SSH + tmux takeover for managed sessions (`A` to attach)
- **Start sessions remotely** — spawn Claude Code on any agent via command palette
- **System health** — CPU, memory, disk, Docker status per machine
- **Projects overview** — registered projects with active session counts
- **Command palette** — fuzzy-filter navigation with `:` or `/`
- **Auto-discovery** — agents watch Claude Code's `sessions.json` with no instrumentation needed

## Architecture

```
┌─────────────┐     gRPC/7400     ┌──────────────┐
│  nexus (TUI) │◄────────────────►│ nexus-agent   │  (homelab)
│              │                  │  watches      │
│  aggregates  │     gRPC/7400    │  sessions.json│
│  all agents  │◄────────────────►├──────────────┤
└─────────────┘                  │ nexus-agent   │  (macbook)
                                 └──────────────┘
         Connected via Tailscale MagicDNS
```

Three crates in a Cargo workspace:

| Crate         | Binary        | Purpose                                       |
| ------------- | ------------- | --------------------------------------------- |
| `nexus-core`  | (lib)         | Shared types, protobuf codegen, session model |
| `nexus-agent` | `nexus-agent` | Per-machine daemon (gRPC + HTTP health)       |
| `nexus-tui`   | `nexus`       | Terminal UI client (ratatui)                  |

## Prerequisites

- Rust stable toolchain
- `protoc` (Protocol Buffer compiler)
- `tmux` (for session attach and managed sessions)
- [Tailscale](https://tailscale.com) (for cross-machine connectivity)

## Quick Start

```bash
# Build
cargo build --release

# Configure agents
mkdir -p ~/.config/nexus
cp config/agents.example.toml ~/.config/nexus/agents.toml
# Edit agents.toml with your machine hostnames

# Run the agent (on each machine)
RUST_LOG=info ./target/release/nexus-agent

# Run the TUI (from any machine)
./target/release/nexus
```

## Install as Service

```bash
# Automated install (detects platform, installs service + binaries)
./deploy/install.sh

# Linux (systemd)
systemctl --user enable --now nexus-agent

# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nexus.agent.plist
```

## Configuration

`~/.config/nexus/agents.toml`:

```toml
[[agents]]
name = "homelab"
host = "homelab"      # Tailscale hostname
port = 7400           # default
user = "nyaptor"      # SSH user for full attach
```

## Key Bindings

| Key       | Action                     |
| --------- | -------------------------- |
| `Tab`     | Cycle screens              |
| `j`/`k`   | Navigate up/down           |
| `Enter`   | Select / view detail       |
| `a`       | Stream attach (read-only)  |
| `A`       | Full attach (SSH + tmux)   |
| `n`       | Start new session          |
| `s`       | Stop session (from detail) |
| `:` `/`   | Command palette            |
| `q` `Esc` | Back / quit                |

## Ports

| Port | Protocol | Purpose                                 |
| ---- | -------- | --------------------------------------- |
| 7400 | gRPC     | Agent API (sessions, events, lifecycle) |
| 7401 | HTTP     | Health check (`GET /health`)            |

## License

MIT
