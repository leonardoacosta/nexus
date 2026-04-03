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

- Sessions tracked via Unix socket events from Claude Code hooks
- System health via sysinfo crate (CPU, RAM, disk)
- Agent registry via TOML config file
- Central SQLite on homelab (datastore role) — 12 tables, all agents
- Credentials, specs, git events, failures, notifications all centralized

## Architecture Notes

> Tailscale mesh with role-based topology:
> - **datastore** (homelab) — hosts nexus.db, serves /ingest + /analytics, always on
> - **notifier** (Mac) — NotificationEngine, TTS, banners, meeting detection
> Cargo workspace: nexus-core (shared), nexus-agent (daemon), nexus-tui (client).
> TUI queries homelab as single source of truth for data views.
> gRPC StreamEvents still peer-to-peer for real-time session updates.
