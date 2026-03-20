# Nexus — Project Configuration

> Rust CLI project. Global rules: `~/.claude/rules/`

## Identity

- **Name**: Nexus
- **Code**: nx
- **Type**: Rust Cargo workspace (agent daemon + TUI client + shared core)
- **Runtime**: Rust (tokio async)
- **Deployment**: systemd (Linux), launchd (macOS) for agent; CLI binary for TUI
- **Secrets**: Tailscale ACLs (no token management needed)
- **Repo**: github.com/leonardoacosta/nexus

## Domain Glossary

| Term | Meaning |
| ---- | ------- |
| Agent | Per-machine daemon that tracks local Claude Code sessions and exposes an API |
| TUI | Terminal UI client that aggregates sessions from all agents |
| Session | A running Claude Code instance on any machine |
| Attach | Connect to a session — either read-only (stream) or full terminal (SSH + tmux) |
| Hub | NOT used — nexus is peer-to-peer, no central server |

## Key User Journeys

| Route | Description |
| ----- | ----------- |
| Dashboard | View all sessions grouped by project across all machines |
| Detail | Inspect a single session — agent activity, beads, TTS history |
| Health | System health metrics per machine (CPU, RAM, disk, Docker) |
| Projects | Overview of all registered projects with session counts |
| Attach | Connect to any session — stream (read-only) or full (SSH + tmux) |

## Architecture

```
Cargo Workspace
├── crates/nexus-core/     Shared types, session model, API contracts
├── crates/nexus-agent/    Per-machine daemon (axum HTTP + WebSocket)
└── crates/nexus-tui/      Terminal UI client (ratatui)
```

### Topology

Peer-to-peer via Tailscale. Each dev server runs `nexus-agent`. The TUI
(`nexus` binary) discovers agents via `~/.config/nexus/agents.toml` and
aggregates sessions from all of them.

### Key Dependencies

| Crate | Purpose |
| ----- | ------- |
| axum | HTTP server for agent API |
| ratatui | Terminal UI rendering |
| tokio | Async runtime |
| reqwest | HTTP client (TUI → agent) |
| sysinfo | System health metrics |
| notify | File watching (sessions.json) |
| crossterm | Terminal event handling |

## Build / Run Commands

| Command | Purpose |
| ------- | ------- |
| `cargo build` | Build all crates |
| `cargo build -p nexus-agent` | Build agent only |
| `cargo build -p nexus-tui` | Build TUI only |
| `cargo run -p nexus-agent` | Run agent locally |
| `cargo run -p nexus-tui` | Run TUI locally |
| `cargo test` | Run all tests |
| `cargo clippy` | Lint |
| `cargo fmt --check` | Format check |

## Conventions

- **Edition**: Rust 2024
- **Error handling**: `anyhow` for applications, `thiserror` for library errors
- **Logging**: `tracing` crate with `RUST_LOG` env filter
- **Serialization**: `serde` + `serde_json` for API, `toml` for config
- **Config path**: `~/.config/nexus/agents.toml`
- **Agent port**: 7400
- **Binary names**: `nexus-agent` (daemon), `nexus` (TUI)
