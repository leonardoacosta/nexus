# Nexus — Project Configuration

> TypeScript / Bun monorepo with a Swift dashboard suite. Global rules: `~/.claude/rules/`

## Identity

- **Name**: Nexus
- **Code**: nx
- **Type**: pnpm + Bun monorepo (agent + statusline + Swift apps + shared packages)
- **Runtime**: Bun for the agent and Node helpers; Swift for the dashboard suite
- **Deployment**: systemd user unit (Linux), launchd user agent (macOS); Swift dashboard ships as Nexus.app
- **Secrets**: Tailscale ACLs (no token management needed)
- **Repo**: github.com/leonardoacosta/nexus

## Domain Glossary

| Term | Meaning |
| ---- | ------- |
| Agent | Per-machine Bun daemon (`apps/agent`) — watches `sessions.json`, owns the socket spine |
| Dashboard | Swift app (`apps/swift/nexus-mac`) — multi-platform dashboard reading from the agent |
| iOS / Watch | `apps/swift/nexus-ios` + `apps/swift/nexus-watch` — companion clients sharing NexusShared |
| NexusShared | Shared Swift framework (`apps/swift/NexusShared`) — models, networking, observers, synthesis |
| Session | A running Claude Code instance on any machine |
| Attach | Connect to a session — stream (read-only) or full terminal (SSH + tmux) |
| Hook ingest | CC PreToolUse/PostToolUse/Stop events arrive via UNIX socket (`socket-server`) |
| Lifecycle bus | `NotificationFired` / `SpecTransition` / `SubagentStarted` events fan out via dispatcher |
| Hub | NOT used — peer-to-peer over Tailscale, no central server |

## Key User Journeys

| Route | Description |
| ----- | ----------- |
| Dashboard | View all sessions grouped by project across all machines |
| Detail | Inspect a single session — agent activity, beads, TTS history |
| Health | System health metrics per machine (CPU, RAM, disk, Docker) |
| Projects | Overview of all registered projects with session counts |
| Attach | Connect to any session — stream (read-only) or full (SSH + tmux) |
| Subagent tree | Visualise spawn tree for Task tool fan-outs (parent/child columns) |

## Architecture

```
Monorepo
├── apps/
│   ├── agent/             Bun daemon — socket spine, hook ingest, dispatcher, schema-drift
│   ├── nexus-emit/        Bun helper — `nexus emit` socket client used by git hooks
│   ├── nexus-statusline/  CC statusline extension
│   └── swift/
│       ├── nexus-mac/     macOS menu bar dashboard
│       ├── nexus-ios/     iOS client
│       ├── nexus-watch/   watchOS companion
│       └── NexusShared/   Shared Swift framework (Models, Networking, Observers, Synthesis)
└── packages/
    ├── core/              Shared TS types + session model + protocol contracts
    └── db/                SQLite schema + drift detector
```

### Spine

The agent owns a single UNIX socket (`socket-server`) for hook ingest. The
former HTTP `/hooks` endpoint was removed. Inbound events flow:

```
CC hook (PreToolUse/Stop/etc.)
   -> nexus-emit (socket client)
      -> socket-server (apps/agent)
         -> dispatcher
            -> NotificationFired / SpecTransition / SubagentStarted bus
               -> subscribers: NexusShared observers, Swift dashboards, statusline
```

### Topology

Peer-to-peer via Tailscale. Each dev server runs `nexus-agent`. Swift clients
(`apps/swift/*`) discover agents via `~/.config/nexus/agents.toml` and aggregate
sessions over the network. See [docs/nexus-topology.html](../docs/nexus-topology.html)
for the full topology diagram and
[docs/nexus-evolution.html](../docs/nexus-evolution.html) for the migration
history.

### Key Dependencies

| Tool | Purpose |
| ---- | ------- |
| bun | Agent runtime + build (`bun build --compile`) |
| pino | Structured logging across the agent |
| sqlite | Persistence (`packages/db`) — sessions, hooks, notifications, schema drift |
| xcodegen | Generates `apps/swift/nexus.xcodeproj` from `project.yml` |
| ratatui | (legacy CLI dashboard, retired) |

## Build / Run Commands

| Command | Purpose |
| ------- | ------- |
| `pnpm install` | Install workspace deps |
| `bun run --filter @nexus/agent build` | Build agent binary |
| `bun run --filter @nexus/agent dev` | Run agent locally with hot reload |
| `cd apps/swift && xcodegen generate` | Regenerate Xcode project |
| `xcodebuild -scheme nexus-mac` | Build Mac dashboard |
| `./deploy/install.sh` | Env-aware install (Linux systemd / macOS launchd + Nexus.app) |
| `bun test` | Run agent + package tests |

## Conventions

- **Runtime**: Bun for TS/JS code paths; never `tsc` for execution
- **Error handling**: structured errors via pino with OpenTelemetry trace ids
- **Serialization**: `serde`-style typed payloads via `packages/core` schemas
- **Config path**: `~/.config/nexus/agents.toml`
- **Agent port**: 7400 (Tailscale-only)
- **Socket path**: `~/.config/nexus/agent.sock` (local IPC only)
- **Binary names**: `nexus-agent` (daemon), `nexus-emit` (hook helper), `nexus-statusline`
