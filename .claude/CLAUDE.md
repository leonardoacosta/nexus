# Nexus — Project Configuration

> TypeScript / Bun monorepo with a Swift dashboard suite. Global rules: `~/.claude/rules/`

## Identity

- **Name**: Nexus
- **Code**: nx
- **Type**: Bun monorepo (agent + statusline + Swift apps + shared packages)
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
    └── db/                Drizzle schema (PostgreSQL) + drift detector
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
| postgres + drizzle-orm | Persistence (`packages/db`) — sessions, hooks, notifications, schema drift. Migrated from SQLite on 2026-04-03 (commit b0061761). |
| drizzle-kit | Schema migrations — `bun run --filter @nexus/db db:generate` (commit the migration); deploy applies via `db:migrate`. NEVER `db:push`. |
| xcodegen | Generates `apps/swift/nexus.xcodeproj` from `project.yml` |
| ratatui | (legacy CLI dashboard, retired) |

### Persistence — Canonical Postgres Target

| Field | Value |
| ----- | ----- |
| Driver | `drizzle-orm/postgres-js` (Bun-compatible) |
| Container | `homelab-postgres` (pgvector/pgvector:pg16) |
| Host | `localhost:5436` (loopback on homelab) / `100.73.182.4:5436` (Tailscale) |
| Database | `nexus` — multi-tenant container also hosts `cortex`, `immich`, `nova` |
| User | `cortex` (shared role; schemas isolated by DB) |
| Env var | `POSTGRES_URL` — see `deploy/secrets.env.example` for canonical form |
| Migrations | Migration-based ONLY: edit schema → `bun run --filter @nexus/db db:generate` → commit the `.sql` migration → the **deploy** applies it via `bun run --filter @nexus/db db:migrate` against `POSTGRES_URL`. **NEVER `db:push`** (state-based live-diff: skips the migrations journal, can silently drop columns, collides with `db:migrate` replay → "already exists" drift — the nx-vtzmd incident, 2026-06-20). Test against a throwaway/local DB with `db:migrate`, never `db:push` on the shared homelab DB. |
| Schema boundary | See `deploy/POSTGRES_SCHEMA_MAP.md` — Nexus writes ONLY to `nexus` DB |

> **Anti-drift rule**: Homelab `~/.env` MUST match `deploy/secrets.env.example` for the `POSTGRES_URL` database segment. The 2026-05-26 outage (`nx-dbame`) was caused by `.env` silently drifting from `/nexus` to `/cortex`. `deploy/install.sh` warns on drift at install time; the agent's startup smoke test refuses to listen on :7400 if the schema is missing.

## Build / Run Commands

| Command | Purpose |
| ------- | ------- |
| `bun install` | Install workspace deps |
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
