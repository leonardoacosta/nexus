# Nexus

Peer-to-peer dashboard for managing Claude Code sessions across all your machines.

Each dev server runs a lightweight agent daemon. Swift dashboards (`Nexus.app`,
iOS, watchOS) and a Next.js web terminal aggregate sessions from every agent over
Tailscale, letting you monitor, stream, and attach to any Claude Code session
from any client.

## Features

- **Dashboard** — all sessions across all machines, grouped by project, in the Swift apps (macOS / iOS / watchOS)
- **Web terminal** — browser-based terminal for streaming and attaching to sessions
- **Live streaming** — read-only event stream for any session
- **Full attach** — SSH + tmux takeover for managed sessions
- **Start sessions remotely** — spawn Claude Code on any agent
- **System health** — CPU, memory, disk, Docker status per machine
- **Projects overview** — registered projects with active session counts
- **Auto-discovery** — agents watch Claude Code's `sessions.json` with no instrumentation needed

## Architecture

```
┌─────────────────────┐                ┌───────────────────────┐
│  Swift dashboards   │   HTTP/7400    │  nexus-agent (Bun)    │  (homelab)
│  Nexus.app / iOS /  │◄──────────────►│   socket spine        │
│  watchOS — share    │                │   dispatcher          │
│  NexusShared        │   HTTP/7400    │   sessions.json watch │
└─────────────────────┘◄──────────────►├───────────────────────┤
                                       │  nexus-agent (Bun)    │  (macbook)
                                       └───────────────────────┘
         Connected via Tailscale MagicDNS
```

Monorepo layout — bun workspace with Bun runtime + Swift dashboard suite:

| Package / App                    | Purpose                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `apps/agent`                     | Per-machine daemon — socket spine, hook ingest, dispatcher, drift     |
| `apps/nexus-emit`                | Hook helper — `nexus emit` socket client used by git hooks            |
| `apps/nexus-statusline`          | CC statusline extension                                                |
| `apps/swift/nexus-mac`           | macOS menu bar dashboard                                               |
| `apps/swift/nexus-ios`           | iOS client                                                             |
| `apps/swift/nexus-watch`         | watchOS companion                                                      |
| `apps/swift/NexusShared`         | Shared Swift framework (Models, Networking, Observers, Synthesis)     |
| `apps/web`                       | Next.js browser terminal (Ghostty WASM) — covered by tests/e2e/playwright |
| `packages/core`                  | Shared TS types, session model, protocol contracts                    |
| `packages/db`                    | PostgreSQL schema (Drizzle) + drift detector                          |

Inbound hook flow (CC -> socket only — HTTP `/hooks` endpoint is retired):

```
CC PreToolUse/Stop  →  nexus-emit  →  agent socket-server  →  dispatcher
                                                                  ↓
                              NotificationFired / SpecTransition / SubagentStarted bus
                                                                  ↓
                              NexusShared observers → Swift dashboards + statusline
```

See [docs/nexus-topology.html](docs/nexus-topology.html) and
[docs/nexus-evolution.html](docs/nexus-evolution.html) for the full topology
diagram and migration history.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 (agent runtime + build + workspace install)
- `tmux` (for session attach and managed sessions)
- [Tailscale](https://tailscale.com) (for cross-machine connectivity)
- macOS only: [XcodeGen](https://github.com/yonaskolb/XcodeGen) + Xcode CLT (for Swift dashboards)

## Quick Start

```bash
# Install workspace deps
bun install

# Configure agents
mkdir -p ~/.config/nexus
cp config/agents.example.toml ~/.config/nexus/agents.toml
# Edit agents.toml with your machine hostnames

# Build + install for this machine (Linux systemd or macOS launchd + Nexus.app)
./deploy/install.sh

# Or run the agent in dev mode without installing
bun run --filter @nexus/agent dev
```

## Install as Service

```bash
# Automated install — detects platform and branches:
#   Linux  -> bun build, install to ~/.local/bin, systemd user unit
#   macOS  -> bun build for the agent + xcodegen/xcodebuild for the
#             Swift dashboard, copy Nexus.app to /Applications,
#             generate launchd plist for the agent
./deploy/install.sh

# Linux post-install
systemctl --user start nexus-agent
journalctl --user -u nexus-agent -f

# macOS post-install — install.sh already bootstraps the GUI launch agents
# (dev.leonardoacosta.nexus.deploy / .ios-deploy / .presence). Just launch the app:
open /Applications/Nexus.app
```

Flags:

| Flag | Effect |
| ---- | ------ |
| `--no-build` | Skip Bun + Xcode build steps. Installs pre-built binaries from `apps/*/`. |
| `--dashboard` | Linux-only — install the legacy Next.js dashboard service + Traefik proxy. New installs should use the Swift dashboard. |

## Configuration

`~/.config/nexus/agents.toml`:

```toml
[[agents]]
name = "homelab"
host = "homelab"      # Tailscale hostname
port = 7400           # default
user = "nyaptor"      # SSH user for full attach
```

## Ports

| Port | Protocol | Purpose                                                              |
| ---- | -------- | -------------------------------------------------------------------- |
| 7400 | HTTP     | Agent API (sessions, events, lifecycle) — Tailscale-only             |
| 7401 | HTTP     | Health check (`GET /health`)                                         |
| sock | UNIX     | Local hook ingest at `~/.config/nexus/agent.sock` (no network)       |

## License

MIT
