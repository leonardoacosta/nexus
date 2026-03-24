# Product Requirements Document — Nexus

> Generated: 2026-03-20 | Updated: 2026-03-20 (ambiguity audit pass 3 — attach model resolved)
> Source artifacts: scope-lock.md, brand/
> Clarity score: 10/10 — all questions resolved (see ambiguity-audit.md)

---

## 1. Vision & Problem Statement

**Vision:** Unified session visibility and attachment across machines, surfaces, and projects.

**Problem:** Claude Code sessions run on multiple dev servers (Linux homelab, Mac). There is no
single surface to see all running sessions, their status, or jump into any of them. Current session
tracking lives inside claude-daemon, scoped to one machine. Cross-machine visibility requires
SSH-ing into each server and manually checking.

**One sentence:** "Where are my agents, and let me jump into any of them."

**Differentiator:** Peer-to-peer architecture via Tailscale — no central server, no cloud
dependency. Each machine runs a lightweight agent; the TUI aggregates them. Attach to any session
with a single keypress.

*Source: scope-lock.md*

## 2. Target Users

**Primary user:** Leo — a solo developer running Claude Code across 2+ dev servers on a Tailscale
network, managing 10-20+ concurrent sessions across multiple projects.

**Usage context:**
- Primary dev work on Linux homelab (always-on)
- Secondary dev on Mac
- Monitoring via Mac terminal (TUI) and iPhone (iMessage commands)

**User needs:**
1. See all sessions at a glance without SSH-ing into each machine
2. Identify which sessions are active vs idle vs stale
3. Attach to any session from any surface (read-only stream for all; full terminal for managed sessions)
4. Monitor machine health (CPU, RAM, disk) across all agents
5. Group sessions by project for context

*Source: scope-lock.md (inferred from architecture and iMessage integration)*

**[NOT AVAILABLE — run `/project:user-stories` for personas, journey maps, and wireframes]**

## 3. Success Metrics

| Metric | Target |
|--------|--------|
| Session visibility latency | < 2s from session start to appearing in TUI |
| Attach latency (stream) | < 1s from keypress to gRPC stream rendering |
| Attach latency (full) | < 3s from keypress to tmux attach via SSH |
| Agent health check | < 500ms response time |
| Dashboard refresh | 2s polling interval (MVP), real-time via gRPC stream (M3) |
| Supported machines | 2 (Linux + Mac) at MVP, up to 5 |
| TUI rendering | 20 concurrent sessions render at 60fps with < 50ms input latency |

**Scale target:** 2 machines at MVP, up to 5 machines maximum. Primary device (homelab):
4-5 sessions with up to 10 sub-agents each. Secondary device (Mac): 1 session with up to
5 sub-agents. Upper bound: ~50 session+sub-agent entities across the network.

*Source: scope-lock.md (derived from architecture constraints and heartbeat thresholds)*

## 4. Functional Requirements

### 4.1 Agent (Per-Machine Daemon)

| ID | Requirement | Priority |
|----|-------------|----------|
| A1 | Track local Claude Code sessions via `sessions.json` file watching (inotify on Linux, FSEvents on Mac, polling fallback). These are **ad-hoc sessions** — stream attach only. | Must |
| A2 | Expose gRPC service: `GetSessions`, `GetSession`, `StopSession` RPCs | Must |
| A3 | Expose gRPC server-streaming RPC: `StreamEvents` for real-time session events (protobuf wire format) | Must |
| A4 | Expose HTTP endpoint: GET /health for ops monitoring (curl-friendly JSON) | Must |
| A5 | `StopSession` RPC: send SIGTERM, wait 10s, SIGKILL if still running. Return final status. | Must |
| A6 | Collect machine health metrics (CPU, RAM, disk, load, Docker containers) | Must |
| A7 | Run as systemd service (Linux) and launchd daemon (Mac) | Must |
| A8 | Single binary, no runtime dependencies (except tmux for managed sessions) | Must |
| A9 | Listen on port 7400 (gRPC), 7401 (HTTP /health) | Must |
| A10 | `StartSession` RPC: spawn `tmux new-session -d -s nx-<short-id> -- claude [args]`. Returns session ID and tmux session name. These are **managed sessions** — full attach available. | Must |
| A11 | Migrate to direct hook registration (Option B) after stabilization | Future |

### 4.2 TUI (Terminal Client)

| ID | Requirement | Priority |
|----|-------------|----------|
| T1 | Discover agents via `~/.config/nexus/agents.toml` | Must |
| T2 | Aggregate sessions from all configured agents | Must |
| T3 | Screen: Session Dashboard — sessions grouped by project, status dots, j/k nav | Must |
| T4 | Screen: Session Detail — activity, beads, TTS history, metadata | Should (M3) |
| T5 | Screen: Health Overview — per-machine metrics, Docker, daemon status | Must |
| T6 | Screen: Project Overview — table with session counts per project | Must |
| T7 | Screen: Command Palette — fuzzy search across sessions/projects/actions | Should (M3) |
| T8 | Stream attach: render gRPC `StreamEvents` in TUI (read-only, `a` key). Works for all sessions (managed and ad-hoc). | Must |
| T9 | Full attach: call `crossterm::terminal::disable_raw_mode()`, spawn `ssh user@host -t 'tmux a -t nx-<id>'` as child process, re-enable raw mode on exit (`A` key). **Managed sessions only** — `A` key disabled for ad-hoc sessions with status bar message: `"ad-hoc session — stream only"`. | Must |
| T13 | Start session: TUI can invoke `StartSession` RPC on any agent to spawn a new managed CC session. Prompts for project/cwd. | Should (M3) |
| T10 | Auto-refresh via 2s polling (MVP), gRPC `StreamEvents` for real-time updates (M3) | Must |
| T11 | Agent connection status indicator | Must |
| T12 | Single binary, no runtime dependencies | Must |

### 4.3 iMessage Integration

| ID | Requirement | Priority |
|----|-------------|----------|
| I1 | `nexus list` — list all sessions across machines | Should (M3) |
| I2 | `nexus status` — summary: N sessions, N projects, health | Should (M3) |
| I3 | `nexus attach <project> #<N>` — return SSH command | Should (M3) |
| I4 | `nexus stop <project> #<N>` — stop session remotely | Should (M3) |
| I5 | If agent unreachable, reply: `"<agent-name>: offline (last seen <duration> ago)"` | Should (M3) |

### 4.4 Session Types

| Type | How Created | Stream (`a`) | Full Attach (`A`) | tmux session |
|------|------------|-------------|-------------------|-------------|
| **Managed** | `StartSession` RPC (via TUI or API) | Yes | Yes — `ssh + tmux a -t nx-<id>` | `nx-<short-id>` |
| **Ad-hoc** | Cursor, manual terminal, existing hooks | Yes | No — status bar: `"ad-hoc session — stream only"` | None |

CC does not natively run inside tmux. Managed sessions solve this by having nexus-agent
spawn CC inside a tmux session: `tmux new-session -d -s nx-<short-id> -- claude [args]`.
Ad-hoc sessions (started outside nexus) have no tmux context and are stream-only.

### 4.5 User Flows

```
┌─────────────────────────────────────────────────────────┐
│ Flow 1: View All Sessions                               │
│                                                         │
│ Launch nexus → TUI queries all agents → Dashboard shows │
│ sessions grouped by project → Status dots show state    │
│ → Managed sessions marked with [M], ad-hoc with [A]    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Flow 2: Stream Attach (all sessions)                    │
│                                                         │
│ Dashboard → Navigate to session (j/k) → Press 'a' →    │
│ TUI opens gRPC StreamEvents → Read-only log renders     │
│ → Press 'q' to return to dashboard                      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Flow 3: Full Attach (managed sessions only)             │
│                                                         │
│ Dashboard → Navigate to managed session → Press 'A' →   │
│ TUI spawns: ssh user@host -t 'tmux a -t nx-<id>' →     │
│ User is in session terminal → Detach tmux → Back to TUI │
│                                                         │
│ If ad-hoc session: 'A' shows status bar error:          │
│ "ad-hoc session — stream only (start via nexus for      │
│  full attach)"                                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Flow 4: Start Managed Session (M3)                      │
│                                                         │
│ TUI → Command palette or 'n' key → Select agent →      │
│ Enter project/cwd → StartSession RPC →                  │
│ Agent spawns: tmux new-session -d -s nx-<id> -- claude  │
│ → Session appears in dashboard as managed [M]           │
│ → Full attach available immediately                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Flow 5: Check Machine Health                            │
│                                                         │
│ Dashboard → Tab to Health screen → Per-machine metrics  │
│ (CPU, RAM, disk) → Docker container status → Agent      │
│ connection status                                       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Flow 6: iMessage Check (M3)                             │
│                                                         │
│ iPhone → iMessage "nexus status" → Daemon queries all   │
│ agents → Reply: "3 agents · 12 sess · 2 stale" →       │
│ "nexus attach oo #1" → Reply: SSH command (if managed)  │
│ or "ad-hoc — stream only" (if ad-hoc)                   │
└─────────────────────────────────────────────────────────┘
```

### 4.6 Acceptance Criteria

| Flow | Criterion |
|------|-----------|
| View All Sessions | Dashboard displays sessions from all configured agents within 2s of launch |
| View All Sessions | Sessions grouped by project code, sorted alphabetically |
| View All Sessions | Each session shows: type indicator ([M]/[A]), status dot, project, branch, age, command |
| Stream Attach | gRPC stream starts within 1s of keypress |
| Stream Attach | Log lines render in real-time as agent emits them |
| Stream Attach | `q` key returns to dashboard without disrupting the stream source |
| Stream Attach | Works identically for managed and ad-hoc sessions |
| Full Attach | `A` key on managed session: SSH + tmux attach executes within 3s |
| Full Attach | TUI disables raw mode, spawns SSH child, re-enables raw mode on tmux detach |
| Full Attach | `A` key on ad-hoc session: status bar shows `"ad-hoc session — stream only"` |
| Full Attach | If managed session's tmux died, display error in TUI status bar |
| Start Session | `StartSession` RPC spawns CC in tmux within 2s |
| Start Session | New session appears in dashboard as managed [M] within next polling cycle |
| Machine Health | CPU, RAM, disk display with 2-decimal precision |
| Machine Health | Docker container count and status shown if Docker is running |
| Machine Health | Disconnected agents show `✖` with last-seen timestamp |
| iMessage (M3) | Commands return within 5s |
| iMessage (M3) | `nexus attach` returns SSH+tmux command for managed, "stream only" for ad-hoc |
| iMessage (M3) | Unknown commands return help text |

**[NOT AVAILABLE — run `/project:user-stories` for detailed user journey maps and wireframe prototypes]**

## 5. Business Case

**[NOT AVAILABLE — run `/project:financials` for revenue model, pricing, and unit economics]**

This is an internal developer tool. Business value is measured in:
- Time saved from not SSH-ing into multiple servers to check session state
- Reduced context-switching cost when managing 10-20+ concurrent agent sessions
- Faster incident response when a session goes stale or errors

*Source: inferred from scope-lock.md*

## 6. Design Language

### 6.1 Color System

Cyber green on dark. Inspired by btop's density with lazygit's clarity.

| Role | Hex | ANSI | Usage |
|------|-----|------|-------|
| Primary (green) | `#00D26A` | Green | Active status, focused borders, primary text |
| Primary bright | `#39FF14` | Bright Green | Sparklines, braille activity, accents |
| Primary dim | `#0A4A2A` | — | Selected row background |
| Secondary (cyan) | `#00CED1` | Cyan | Links, secondary info, agent names |
| Warning (amber) | `#FFB700` | Yellow | Idle status, warnings |
| Error (red) | `#FF3B3B` | Red | Error status, disconnected |
| Neutral text | `#C0C0C0` | White | Body text, labels |
| Neutral dim | `#666666` | Bright Black | Borders, separators, inactive |
| Background | `#0D0D0D` | — | Terminal background |
| Surface | `#1A1A1A` | — | Panel backgrounds |
| Surface highlight | `#2A2A2A` | — | Hover/selected row |

All primary and text colors exceed WCAG AA against the background. Primary green achieves
AAA (8.2:1).

### 6.2 Typography

Terminal-native — the user's terminal font applies. No font choice in the TUI itself.

| Level | Style | Example |
|-------|-------|---------|
| Title | UPPERCASE, bold, primary green | `SESSION DASHBOARD` |
| Section | Title case, dim green | `Machine Health` |
| Label | lowercase, neutral dim | `project:` `branch:` |
| Value | Regular, neutral text | `oo` `main` `3m ago` |
| Status | Bold, status color | `●` `○` `◌` `✖` |
| Sparkline | Braille, bright green | `⠀⠠⠰⠸⣰⣸⣿` |

For documentation/web surfaces: JetBrains Mono, Fira Code, or Cascadia Code (fallback chain
in `tokens.css`).

### 6.3 UI Specifications

**Box drawing:**
- Panel borders: `┌ ─ ┐ │ └ ┘` (Unicode box-drawing)
- Active panel: primary green border; inactive: dim (#666666)
- Selected row: inverted background (#0A4A2A)

**Status indicators:**
| Status | Dot | Sparkline | Color |
|--------|-----|-----------|-------|
| Active | `●` | `⣿⣸⣰⠸` (high) | #00D26A |
| Idle | `○` | `⠠⠰⠀⠀` (low) | #FFB700 |
| Stale | `◌` | `⠀⠀⠀⠀` (flat) | #666666 |
| Error | `✖` | none | #FF3B3B |

**Icons:** Unicode characters only in TUI. Lucide icons (1.5px stroke, 20px) for
docs/web surfaces.

**Design principles:**
1. Density over decoration — every pixel earns its space
2. Green means go — primary color signals activity
3. Keyboard-first — visual affordances for keyboard nav, not mouse
4. Instant legibility — a glance tells you session count, activity, problems
5. Consistent status language — same colors and symbols everywhere

**Voice:** Direct, precise, technical, terse. Fragments over sentences. Data over
description. No emoji in output.

*Source: brand/brand-identity.md, brand/icon-style.md, brand/tokens.css*

## 7. Technical Architecture

### 7.1 Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Agent | Rust, tonic, tokio | gRPC server. Matches daemon toolchain. Single binary. Cross-platform. |
| TUI | Rust, ratatui, tonic | gRPC client. Mature TUI framework (10k+ stars). |
| IPC | gRPC (tonic/prost) + HTTP /health | Typed protobuf RPC with streaming. HTTP health for curl/monitoring. |
| Wire format | Protobuf | Schema-enforced, compact, versioned. `.proto` files as API contract. |
| Config | TOML | Rust ecosystem standard. Human-readable. |
| Build | Cargo workspace | Agent + TUI + shared core (incl. protobuf codegen) in one repo. |
| CI | GitHub Actions | Cross-compile: linux-x86_64, darwin-aarch64. |
| Auth | Tailscale ACLs | Zero config within Tailnet. |
| Attach | SSH + tmux | Proven, universal, no custom protocol. |

### 7.2 Topology

Peer-to-peer via Tailscale. No central server or database.

```
DEV SERVERS (nexus-agent daemon):
  ├── Linux homelab (primary, always-on)
  └── Mac (secondary)

CLIENT SURFACES:
  ├── Mac terminal → nexus TUI → aggregates all agents
  └── iPhone → iMessage → existing claude-daemon infra

NETWORK: Tailscale (all machines on same Tailnet)
AUTH: Tailscale ACLs (trusted network)
ATTACH: SSH + tmux (universal)
```

### 7.3 Data Model

**Session:**
```
id, pid, project, cwd, branch, started_at, last_heartbeat,
status (Active|Idle|Stale|Errored), spec, command, agent,
session_type (Managed|AdHoc), tmux_session (Some("nx-<id>") for Managed, None for AdHoc)
```

**AgentInfo:**
```
name, host, port, os, sessions[], health, connected
```

**MachineHealth:**
```
cpu_percent, memory_used_gb, memory_total_gb, disk_used_gb,
disk_total_gb, load_avg[3], uptime_seconds, docker_containers[]
```

### 7.4 API Surface (Agent)

**gRPC Service (port 7400):**

```protobuf
service NexusAgent {
  rpc GetSessions(SessionFilter) returns (SessionList);
  rpc GetSession(SessionId) returns (Session);
  rpc StartSession(StartSessionRequest) returns (StartSessionResponse);
  rpc StreamEvents(EventFilter) returns (stream SessionEvent);
  rpc StopSession(SessionId) returns (StopResult);
}

message StartSessionRequest {
  string project = 1;          // project code (oo, tc, nx...)
  string cwd = 2;              // working directory
  repeated string args = 3;    // additional claude CLI args
}

message StartSessionResponse {
  string session_id = 1;
  string tmux_session = 2;     // "nx-<short-id>" — for SSH+tmux attach
  SessionType type = 3;        // always MANAGED for StartSession
}

enum SessionType {
  MANAGED = 0;   // spawned by nexus, tmux-wrapped, full attach available
  AD_HOC = 1;    // detected via sessions.json, stream-only
}

message SessionEvent {
  string session_id = 1;
  EventType type = 2;
  google.protobuf.Timestamp ts = 3;
  oneof payload {
    SessionStarted started = 4;
    HeartbeatReceived heartbeat = 5;
    StatusChanged status = 6;
    SessionStopped stopped = 7;
  }
}
```

**HTTP Health (port 7401):**

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Agent health + machine metrics (JSON, curl-friendly) |

The health endpoint remains HTTP for ops tooling compatibility (curl, monitoring agents,
uptime checks). All session operations use gRPC.

### 7.5 Session Discovery

**MVP (Option A):** Agent watches `sessions.json` via inotify (Linux) / FSEvents (Mac) with
polling fallback. No hook changes needed.

**Target (Option B):** Hooks emit directly to nexus agent gRPC API. Session tracking removed
from claude-daemon.

Migration gate: Option B begins after 2 weeks of production use with zero session-tracking
regressions on Option A.

### 7.6 Heartbeat Strategy

**MVP:** Infer heartbeats from `sessions.json` file mtime (aligns with Option A). File-level
granularity — cannot distinguish which session is active.

**Target:** Per-session HTTP heartbeat from CC hooks to nexus agent (aligns with Option B).
Rich metadata: current command, agent type, status. Enables real-time events.

### 7.7 Project Registry

Nexus agent maintains its own project registry, independent of claude-daemon's `projects.json`.
Decoupled from daemon lifecycle — nexus can evolve its project model without daemon changes.

### 7.8 Alert Notifications

When session status transitions to `Stale` or `Errored`, the agent emits a `StatusChanged`
event via gRPC stream. The TUI renders a status bar notification. Future: hook into existing
TTS/notification infrastructure for push alerts to iPhone/Apple Watch.

### 7.9 Agent Discovery

Config-file based: `~/.config/nexus/agents.toml`

```toml
[[agents]]
name = "homelab"
host = "homelab"     # Tailscale MagicDNS
port = 7400
user = "nyaptor"

[[agents]]
name = "macbook"
host = "macbook"
port = 7400
user = "nyaptor"
```

Future: mDNS/Tailscale auto-discovery.

**[NOT AVAILABLE — run `/project:infra` for detailed infrastructure plan, Terraform stubs,
and deployment configuration]**

## 8. Scope & Constraints

### 8.1 In Scope (v1)

| Milestone | Deliverables |
|-----------|-------------|
| M1: Agent + Core (Week 1) | Cargo workspace, protobuf definitions, gRPC server, session model, HTTP /health, systemd/launchd, agents.toml, CI |
| M2: TUI Dashboard (Week 2) | ratatui scaffold, gRPC client, dashboard/health/projects screens, multi-agent aggregation, polling |
| M3: Attach + Detail (Week 3) | Detail screen, command palette, gRPC `StreamEvents`, SSH+tmux attach, alert notifications, iMessage |

### 8.2 Out of Scope (v1)

- Session orchestration beyond start/stop (managing worktrees, running specs, restarting)
- Cost tracking / analytics
- Notification system modifications
- Replacing claude-daemon (only session tracking moves)
- Web dashboard
- Telegram bot
- Windows support
- Multiplexer-agnostic abstraction (zellij)
- Session recording + playback
- mDNS/Tailscale auto-discovery

### 8.3 Hard Constraints

| Constraint | Detail |
|------------|--------|
| Network | Tailscale only — no public internet exposure |
| Auth | Tailscale ACLs — no token management, no secrets |
| Binary | Single static binary per component (agent, TUI). Agent requires tmux on PATH for managed sessions. |
| Ports | 7400 (gRPC), 7401 (HTTP /health) |
| Config | `~/.config/nexus/agents.toml` |
| Rust edition | 2024 |
| Attach method | SSH + tmux — no custom terminal protocol |

## 9. Timeline

| Week | Milestone | Key Deliverables |
|------|-----------|-----------------|
| 1 | M1: Agent + Core | Working agent daemon with gRPC service + HTTP /health, protobuf schemas, CI pipeline |
| 2 | M2: TUI Dashboard | Functional TUI with 3 screens, gRPC client, multi-agent aggregation |
| 3 | M3: Attach + Detail | Full attach capability, gRPC streaming, alert notifications, detail screen, iMessage |
| Post-MVP | Future | Hook migration, web dashboard, auto-discovery, Windows |

*Source: scope-lock.md*

**[NOT AVAILABLE — run `/project:financials` for timeline-to-financial milestone mapping]**

## 10. Open Questions

No open questions remain.

### Resolved Questions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | tmux session naming? | Nexus-managed: `nx-<short-id>`. Ad-hoc: no tmux (stream-only). | CC does not use tmux natively. Nexus creates tmux sessions only for managed sessions via `StartSession` RPC. |
| 2 | Stream format? | Protobuf via gRPC `StreamEvents` | Schema-enforced, compact, versioned. Cross-language client support. |
| 3 | Project registry source? | Own registry (decoupled from daemon) | Independent evolution. No daemon lifecycle dependency. |
| 4 | Heartbeat ownership? | File mtime (MVP) → HTTP heartbeat (Option B) | Two-phase matches session discovery migration path. |
| 5 | Attach model? | Nexus-managed sessions (two-tier). | Managed sessions get full terminal attach via tmux. Ad-hoc sessions get stream-only. Validated by OpenClaw research — even they chose stream-only, but our use case requires interactive control. |

---

*Generated from 2 of 6 possible artifacts. Sections marked [NOT AVAILABLE] require additional
planning commands.*
