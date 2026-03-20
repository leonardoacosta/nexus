# Nexus — Project Reference

## Domain Model

| Term | Meaning |
| ---- | ------- |
| Agent | Per-machine daemon that tracks local Claude Code sessions and exposes an API |
| TUI | Terminal UI client that aggregates sessions from all agents |
| Session | A running Claude Code instance on any machine |
| Attach | Connect to a session — either read-only (stream) or full terminal (SSH + tmux) |
| Registry | Agent discovery via ~/.config/nexus/agents.toml |

## Key User Journeys

| Route | Description |
| ----- | ----------- |
| Dashboard | View all sessions grouped by project across all machines |
| Detail | Inspect a single session — agent activity, beads, TTS history |
| Health | System health metrics per machine (CPU, RAM, disk, Docker) |
| Projects | Overview of all registered projects with session counts |
| Attach | Connect to any session — stream (read-only) or full (SSH + tmux) |

## Data Scope

- Sessions discovered via file watching (~/.claude/projects/*/sessions.json)
- System health via sysinfo crate (CPU, RAM, disk)
- Agent registry via TOML config file
- No database — all state is ephemeral or file-based

## Architecture Notes

> Peer-to-peer via Tailscale. No central hub.
> Each machine runs nexus-agent (axum). TUI aggregates via HTTP/WebSocket.
> Cargo workspace: nexus-core (shared), nexus-agent (daemon), nexus-tui (client).
