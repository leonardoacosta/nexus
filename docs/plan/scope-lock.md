# Nexus — Scope Lock

> Locked: 2026-03-20
> Owner: leonardoacosta
> Repo: github.com/leonardoacosta/nexus

## Vision

Unified session visibility and attachment across machines, surfaces, and projects. See every
Claude Code session running anywhere on your network. Attach to any of them from any surface.

**One sentence:** "Where are my agents, and let me jump into any of them."

## Non-Goals (Out of Scope)

- **Session orchestration** — nexus does NOT spawn agents, manage worktrees, or run specs.
  That's `/apply`, `/apply:all`, and the 29 typed agents in `~/.claude`.
- **Cost tracking / analytics** — CO and telemetry handle this.
- **Notification system** — TTS, Apple Watch, existing notification infrastructure stays.
- **Replacing claude-daemon** — daemon continues to handle TTS, server monitoring, git watch,
  credential management. Nexus only takes over session tracking.
- **Web dashboard (MVP)** — future surface, not in initial scope.
- **Telegram bot (MVP)** — future surface, not in initial scope.
- **Windows support (MVP)** — future, when Windows dev server materializes.

## Architecture

### Topology: Peer-to-Peer via Tailscale

```
DEV SERVERS (run nexus agent + Claude Code):
  ├── Linux homelab (primary, always on)
  └── Mac (secondary dev server)

CLIENT SURFACES (Leo connects from):
  ├── Mac terminal → nexus TUI → aggregates ALL sessions
  └── iPhone → iMessage commands → via existing claude-daemon infra

NETWORK: Tailscale (all machines on same Tailnet)
AUTH: Tailscale ACLs (trusted network, no token management)
ATTACH: SSH + tmux attach (proven, universal)
```

### Components

#### 1. Nexus Agent (per-machine daemon)

**What:** Lightweight persistent daemon that tracks local Claude Code sessions and exposes
an API for remote queries.

**Runs on:** Every dev server (Linux homelab, Mac)

**Responsibilities:**
- Receive session registration events from Claude Code hooks
- Track session lifecycle (start, heartbeat, stop)
- Expose HTTP API for session queries
- Expose WebSocket for real-time session events
- Register on Tailscale MagicDNS for discovery

**Replaces:** Session tracking in claude-daemon (`session_manager.rs`, `sessions.json`,
`GET /sessions` endpoint). Other daemon responsibilities (TTS, git watch, server monitor)
remain untouched.

**State:** Per-machine session registry. No central database.

**API Surface:**
```
GET  /sessions              — list active sessions
GET  /sessions/:id          — session detail
GET  /sessions/:id/stream   — SSE stream of session log
WS   /ws                    — real-time session events
GET  /health                — agent health + machine metrics
POST /sessions/:id/stop     — graceful stop (SIGTERM → SIGKILL)
```

**Tech:** Rust, axum, tokio. Single binary. systemd on Linux, launchd on Mac.

#### 2. Nexus TUI (client)

**What:** Terminal UI that aggregates sessions from all nexus agents on the Tailnet and
provides dashboard + attach capabilities.

**Runs on:** Mac (primary client machine), or any machine with terminal access.

**Responsibilities:**
- Discover nexus agents on Tailnet (MagicDNS or config file)
- Aggregate sessions from all agents into unified view
- Display 5 screens (dashboard, detail, health, projects, command palette)
- Attach to sessions via SSH + tmux
- Stream session logs in read-only mode
- Escalate from stream to full attach

**Tech:** Rust, ratatui, reqwest (HTTP), tungstenite (WebSocket). Single binary.

**Screens:**
1. **Session Dashboard** — all sessions grouped by project, status dots, keyboard nav
2. **Session Detail** — agent activity, beads, recent TTS, full metadata
3. **Health Overview** — per-machine metrics, daemon status, Docker containers
4. **Project Overview** — all projects with session counts, deploy status, beads
5. **Command Palette** — fuzzy search across sessions, projects, actions

**Attach Modes:**
- **Stream (default)** — read-only view of session's JSONL log via SSE
- **Full attach (escalate)** — SSH + tmux attach to session's terminal
- Switching: press `a` for stream → press `A` (shift) for full attach

#### 3. iMessage Integration (via existing daemon)

**What:** New command handlers in claude-daemon's IMessageReaderService.

**Commands:**
```
nexus list              — list all sessions across all machines
nexus status            — summary (N sessions, N projects, health)
nexus attach oo #1      — returns SSH command to paste into terminal
nexus stop oo #2        — stop a session remotely
```

**Implementation:** Add handlers to existing iMessage command parser. Daemon queries nexus
agents via HTTP, formats response, replies via AppleScript.

**NOT in scope:** Terminal-in-iMessage. Just returns information and SSH commands.

### Data Flow

```
Claude Code session starts
  ↓
Hook emits session_register event
  ↓
Nexus Agent receives, adds to local registry
  ↓
Nexus Agent broadcasts via WebSocket
  ↓
Nexus TUI (on Mac) receives, updates dashboard
  ↓
User selects session, presses 'a'
  ↓
TUI opens SSE stream from agent API → read-only view
  ↓
User presses 'A' to escalate
  ↓
TUI executes: ssh user@host -t 'tmux attach -t session-name'
  ↓
User is now in the session's terminal
```

### Session Discovery (Hook Migration)

Currently, Claude Code hooks emit events to claude-daemon via `claude-emit`. For nexus:

**Option A (MVP):** Nexus agent watches `sessions.json` (written by daemon). No hook changes.
Daemon continues to register sessions. Nexus reads the file.

**Option B (Target):** Migrate session hooks to emit directly to nexus agent's HTTP API.
Remove session tracking from claude-daemon. Daemon no longer manages `sessions.json`.

**Migration path:** Ship with Option A, migrate to Option B once nexus agent is stable.

### Agent Discovery

TUI discovers agents via:

1. **Config file** (primary): `~/.config/nexus/agents.toml`
   ```toml
   [[agents]]
   name = "homelab"
   host = "homelab"  # Tailscale MagicDNS name
   port = 7400
   user = "nyaptor"  # for SSH attach

   [[agents]]
   name = "macbook"
   host = "macbook"  # Tailscale MagicDNS name
   port = 7400
   user = "nyaptor"
   ```

2. **mDNS/Tailscale discovery** (future): Auto-discover agents broadcasting on the Tailnet.

### Port Assignment

Nexus agent: **7400** (not conflicting with any existing service).

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Agent | Rust, axum, tokio | Matches daemon toolchain. Single binary. Cross-platform. |
| TUI | Rust, ratatui | Mature (10k+ stars). Same language as agent. Single binary. |
| IPC | HTTP + WebSocket | Simple, debuggable, works across network. |
| Config | TOML | Rust ecosystem standard. Human-readable. |
| Build | Cargo workspace | Agent + TUI in one repo, shared types. |
| CI | GitHub Actions | Cross-compile: linux-x86_64, darwin-aarch64 |
| Auth | Tailscale ACLs | Zero config within Tailnet. |
| Attach | SSH + tmux | Proven, universal, no custom protocol. |

## Cargo Workspace Structure

```
nexus/
├── Cargo.toml              (workspace)
├── crates/
│   ├── nexus-agent/        (per-machine daemon)
│   │   └── src/main.rs
│   ├── nexus-tui/          (terminal UI client)
│   │   └── src/main.rs
│   └── nexus-core/         (shared types, session model, API types)
│       └── src/lib.rs
├── docs/
│   ├── plan/
│   │   └── scope-lock.md   (this file)
│   └── wireframes/
└── .github/
    └── workflows/
```

## Session Model

```rust
pub struct Session {
    pub id: String,              // UUID
    pub pid: u32,                // process ID on host machine
    pub project: Option<String>, // project code (oo, tc, cc...)
    pub cwd: String,             // working directory
    pub branch: Option<String>,  // git branch
    pub started_at: DateTime<Utc>,
    pub last_heartbeat: DateTime<Utc>,
    pub status: SessionStatus,   // Active, Idle, Stale, Errored
    pub spec: Option<String>,    // active spec name
    pub command: Option<String>, // current command (/apply, /feature...)
    pub agent: Option<String>,   // current agent type
    pub tmux_session: Option<String>, // tmux session name for attach
}

pub enum SessionStatus {
    Active,       // heartbeat < 60s, agent executing
    Idle,         // heartbeat < 300s, waiting for input
    Stale,        // heartbeat > 300s
    Errored,      // process dead or disconnected
}

pub struct AgentInfo {
    pub name: String,            // machine name (homelab, macbook)
    pub host: String,            // Tailscale hostname
    pub port: u16,               // API port
    pub os: String,              // linux, macos, windows
    pub sessions: Vec<Session>,
    pub health: MachineHealth,
    pub connected: bool,
}

pub struct MachineHealth {
    pub cpu_percent: f32,
    pub memory_used_gb: f32,
    pub memory_total_gb: f32,
    pub disk_used_gb: f32,
    pub disk_total_gb: f32,
    pub load_avg: [f32; 3],
    pub uptime_seconds: u64,
    pub docker_containers: Option<Vec<ContainerStatus>>,
}
```

## MVP Milestones

### M1: Agent + Core (Week 1)

- [ ] Cargo workspace scaffold (agent, tui, core)
- [ ] Session model + API types in nexus-core
- [ ] Nexus agent: HTTP server on port 7400
- [ ] Nexus agent: Watch `sessions.json` for session discovery (Option A)
- [ ] Nexus agent: GET /sessions, GET /sessions/:id, GET /health
- [ ] Nexus agent: systemd unit file (Linux), launchd plist (Mac)
- [ ] Agent config: `agents.toml` parser
- [ ] Cross-compile CI (linux-x86_64, darwin-aarch64)

### M2: TUI Dashboard (Week 2)

- [ ] ratatui app scaffold with tab navigation
- [ ] Screen 1: Session Dashboard (grouped by project, status dots, j/k nav)
- [ ] Screen 3: Health Overview (per-machine metrics, Docker, deployments)
- [ ] Screen 4: Project Overview (table with session counts)
- [ ] Multi-agent aggregation (query all agents, merge results)
- [ ] Auto-refresh (poll agents every 2s)
- [ ] Agent connection status indicator

### M3: Attach + Detail (Week 3)

- [ ] Screen 2: Session Detail (agent activity, beads, TTS history)
- [ ] Screen 5: Command Palette (fuzzy search)
- [ ] Stream attach: SSE endpoint on agent, rendered in TUI
- [ ] Full attach: SSH + tmux command execution
- [ ] Attach mode switching (stream ↔ full)
- [ ] Agent WebSocket for real-time updates (replace polling)
- [ ] iMessage command handlers (nexus list, nexus status, nexus attach)

### Future (Post-MVP)

- [ ] Hook migration: emit directly to nexus agent (Option B)
- [ ] Remove session tracking from claude-daemon
- [ ] mDNS/Tailscale auto-discovery
- [ ] Web dashboard (browser-based TUI via xterm.js)
- [ ] Telegram bot
- [ ] Windows agent
- [ ] Multiplexer-agnostic abstraction (zellij support)
- [ ] Session recording + playback

## Open Questions

1. **tmux session naming** — How are tmux sessions named for Claude Code? Need to map
   CC session IDs to tmux session names for attach.
2. **Log streaming format** — Should the SSE stream be raw JSONL or parsed/formatted?
3. **Project registry** — Should nexus agent read `projects.json` from `~/.claude/scripts/config/`
   or maintain its own project registry?
4. **Heartbeat ownership** — Should CC hooks heartbeat to nexus agent directly, or should
   nexus agent infer heartbeats from `sessions.json` mtime?
