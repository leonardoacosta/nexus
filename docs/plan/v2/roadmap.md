# Roadmap — Nexus v2

> Generated: 2026-04-03
> Sources: prd.md, scope-lock.md, user-stories.md, financial-projections.md, context.md
> Structure: 5 waves, 22 specs, ~260 AI-assisted hours

---

## Wave Model

Each wave is a self-contained increment. A wave ships value and unblocks the next wave.
Specs within a wave can run in parallel unless marked with an explicit dependency arrow.

```
Wave 1: Foundation ──► Wave 2: Core ──► Wave 3: Dashboard ──► Wave 4: Interaction ──► Wave 5: Polish
   (scaffold)         (detection)        (web UI)              (terminal relay)        (carry-forward)
   ~40 hrs            ~60 hrs            ~80 hrs               ~50 hrs                 ~30 hrs
```

**Total: ~260 AI-assisted hours** (matches financial-projections.md estimate)

---

## Wave 1: Foundation (~40 hrs)

> Goal: Project scaffold exists, agent binary starts and serves health, Rust file watcher extracted.

| # | Spec ID | Title | Hours | Deps | Ship Criterion |
|---|---------|-------|------:|------|----------------|
| 1.1 | `add-monorepo-scaffold` | T3 Turbo monorepo scaffold with Bun agent + Next.js dashboard packages | 12 | — | — |
| 1.2 | `add-agent-skeleton` | Bun HTTP server on :7400 with `/health` endpoint returning hostname + uptime | 10 | 1.1 | #4 (partial) |
| 1.3 | `add-rust-file-watcher` | Extract Rust `notify` binary from v1 crate, define IPC protocol (JSON over stdin/stdout) | 10 | — | — |
| 1.4 | `add-agent-service-config` | systemd unit + launchd plist for `nexus-agent` binary (Bun compiled) | 4 | 1.2 | — |
| 1.5 | `add-agent-config-loader` | Hot-reloadable `~/.config/nexus/agents.toml` parser (carry forward format from v1) | 4 | 1.2 | — |

### Wave 1 Exit Criteria

- [ ] `bun run --filter nexus-agent dev` starts an HTTP server on :7400
- [ ] `GET /health` returns `{ hostname, uptime, cpu, ram, disk }` (stubbed values OK)
- [ ] Rust file watcher binary compiles independently and communicates via JSON IPC
- [ ] `systemctl start nexus-agent` works on Linux test machine
- [ ] Monorepo structure: `apps/dashboard`, `apps/agent`, `packages/core`, `packages/watcher`

### Spec Details

#### 1.1 `add-monorepo-scaffold`

**Scope**: Initialize T3 Turbo monorepo with pnpm workspaces and Turborepo.

**Packages**:

| Package | Path | Runtime | Purpose |
|---------|------|---------|---------|
| `@nexus/agent` | `apps/agent` | Bun | Per-machine daemon |
| `@nexus/dashboard` | `apps/dashboard` | Node.js (Next.js) | Central web UI |
| `@nexus/core` | `packages/core` | Bun + Node.js | Shared types, API contracts, validation |
| `@nexus/watcher` | `packages/watcher` | — (Rust binary) | File watcher, build scripts only |

**Key decisions**:
- No tRPC — dashboard uses Server Actions for its own data, HTTP client for agent APIs
- No Drizzle — SQLite accessed via `bun:sqlite` (agent) and `better-sqlite3` (dashboard)
- Shared types in `@nexus/core` — TypeScript interfaces for all API contracts
- Bun for agent compilation (`bun build --compile`), Node.js for Next.js dashboard

**Tasks** (8-10):
- Init pnpm workspace with `pnpm-workspace.yaml`
- Configure `turbo.json` with `build`, `dev`, `lint`, `typecheck` tasks
- Scaffold `apps/agent` with Bun entry point and `tsconfig.json`
- Scaffold `apps/dashboard` with `create-next-app` (App Router, no src dir)
- Scaffold `packages/core` with shared type exports
- Scaffold `packages/watcher` with Cargo.toml and build script
- Add root `package.json` scripts: `dev`, `build`, `lint`, `typecheck`, `test`
- Configure ESLint flat config, Prettier
- Add `.gitignore`, root `tsconfig.json`

#### 1.2 `add-agent-skeleton`

**Scope**: Bun HTTP server that serves the health endpoint and proves the binary compilation path.

**API surface** (initial):

```
GET /health → { hostname, uptime_seconds, cpu_percent, ram_percent, disk_percent, docker_containers }
```

**Implementation**:
- `Bun.serve()` with route handler
- `os` module for hostname, uptime
- Stubbed system metrics (real implementation in Wave 2)
- CORS headers for dashboard access (Tailscale-internal only)
- Structured JSON logging via `@nexus/core` logger

**Tasks** (6-8):
- Create Bun HTTP server with route dispatch
- Implement `/health` endpoint with stubbed system info
- Add CORS middleware (allow Tailscale origins)
- Add structured JSON logging
- Add `bun build --compile` script producing `nexus-agent` binary
- Write tests for health endpoint (Bun test runner)
- Verify compiled binary runs standalone

#### 1.3 `add-rust-file-watcher`

**Scope**: Extract the `notify`-based file watcher from the Rust codebase into a standalone binary
that communicates with the Bun agent via JSON IPC (stdin/stdout).

**IPC protocol**:
```json
// Watcher → Agent (stdout, newline-delimited JSON)
{ "type": "session_start", "session_id": "abc123", "project": "co", "path": "/home/user/.claude/projects/..." }
{ "type": "session_update", "session_id": "abc123", "timestamp": "2026-04-03T..." }
{ "type": "session_end", "session_id": "abc123" }

// Agent → Watcher (stdin, newline-delimited JSON)
{ "type": "watch", "paths": ["/home/user/.claude"] }
{ "type": "shutdown" }
```

**Key decisions**:
- Rust binary is a subprocess of the Bun agent, spawned on startup
- Communication via stdin/stdout (no sockets, no files)
- Watches `~/.claude/projects/` for `sessions.json` changes (same pattern as v1)
- Binary built separately via `cargo build --release` in `packages/watcher`

**Tasks** (6-8):
- Extract `notify` watcher from `crates/nexus-agent/src/watcher/`
- Define IPC message types (Rust structs + serde)
- Implement stdin reader for control messages
- Implement stdout writer for session events
- Add Cargo build script to `packages/watcher`
- Write integration test: spawn watcher, send watch command, verify events
- Document IPC protocol in `packages/watcher/README.md`

#### 1.4 `add-agent-service-config`

**Scope**: systemd and launchd service configurations for the compiled Bun agent binary.

**Tasks** (3-4):
- Create `deploy/nexus-agent.service` (systemd unit)
- Create `deploy/com.nexus.agent.plist` (launchd plist)
- Add install script: `scripts/install-agent.sh` (copies binary + service file, enables service)
- Test service restart on crash (systemd `Restart=on-failure`)

#### 1.5 `add-agent-config-loader`

**Scope**: Parse and hot-reload `~/.config/nexus/agents.toml`.

**Config format** (carry forward from v1):
```toml
[[agents]]
name = "orion"
host = "100.x.y.z"
port = 7400

[[agents]]
name = "nova"
host = "100.x.y.z"
port = 7400
```

**Tasks** (3-4):
- Implement TOML parser with Zod validation
- Add `fs.watch` for hot-reload on config change
- Emit config-change events for downstream consumers
- Write tests for parsing and hot-reload

---

## Wave 2: Core (~60 hrs)

> Goal: Agent detects real sessions, reports real health, stores data in SQLite. This is the
> "headless v2" — all functionality accessible via HTTP API, no UI yet.

| # | Spec ID | Title | Hours | Deps | Ship Criterion |
|---|---------|-------|------:|------|----------------|
| 2.1 | `add-session-detection` | Integrate Rust file watcher IPC with agent, detect and track CC sessions | 14 | 1.2, 1.3 | #1 (data layer) |
| 2.2 | `add-health-monitoring` | Real system metrics: CPU, RAM, disk, Docker via `systeminformation` | 10 | 1.2 | #4 (data layer) |
| 2.3 | `add-sqlite-store` | Per-agent SQLite schema + queries for sessions, health snapshots, events | 12 | 1.2 | — |
| 2.4 | `add-session-api` | `GET /sessions`, `GET /sessions/{id}`, `GET /projects` endpoints | 10 | 2.1, 2.3 | #1 (API layer) |
| 2.5 | `add-nexus-register-hook` | `nexus-register` CC hook binary (Bun compiled) — start/stop/heartbeat | 8 | 2.1 | #1 (detection) |
| 2.6 | `add-health-history` | Periodic health snapshots to SQLite, sparkline-ready time series | 6 | 2.2, 2.3 | #4 (history) |

### Wave 2 Exit Criteria

- [ ] Starting a Claude Code session triggers a `nexus-register` hook that the agent detects
- [ ] `GET /sessions` returns real session data with project, status, duration, last activity
- [ ] `GET /health` returns live CPU %, RAM %, disk %, Docker container count
- [ ] `GET /projects` returns project list with session counts
- [ ] SQLite stores session events and health history (queryable for sparklines)
- [ ] All endpoints documented with example responses

### Spec Details

#### 2.1 `add-session-detection`

**Scope**: Bridge the Rust file watcher IPC events into the agent's session state model.

**Session lifecycle**:
```
nexus-register start → Agent receives IPC event → Session created (status: active)
File watcher heartbeat → Session updated (last_activity)
nexus-register stop → Agent receives IPC event → Session ended (status: ended)
No heartbeat for 5 min → Session marked stale (status: idle)
```

**Session model** (in `@nexus/core`):
```typescript
interface Session {
  id: string           // CC session ID
  project: string      // Project code (e.g., "co", "nx")
  machine: string      // Hostname
  status: "active" | "idle" | "ended"
  started_at: string   // ISO 8601
  last_activity: string
  pid: number          // CC process PID
  cwd: string          // Working directory
}
```

**Tasks** (8-10):
- Define `Session` type in `@nexus/core`
- Implement IPC subprocess manager (spawn Rust watcher, handle lifecycle)
- Parse watcher IPC events into session state transitions
- Implement in-memory session store with status tracking
- Add idle detection (5-minute heartbeat timeout)
- Handle watcher crash recovery (restart subprocess)
- Write integration tests: session lifecycle from watcher event to API

#### 2.2 `add-health-monitoring`

**Scope**: Replace stubbed health data with real system metrics.

**Dependencies**: `systeminformation` npm package (cross-platform, maintained).

**Metrics collected**:
- CPU: overall percent, per-core percent, load average
- RAM: total, used, percent
- Disk: per-mount total, used, percent
- Docker: container count, running count
- Network: interface list, bytes in/out (for expanded detail view)
- Processes: top 10 by CPU, top 10 by RAM (for expanded detail view)

**Tasks** (6-8):
- Add `systeminformation` dependency
- Implement health collector with configurable interval (default: 5s)
- Structure health response matching PRD REQ-HEALTH-2
- Add per-process breakdown for expanded detail (REQ-HEALTH-4)
- Handle Docker not installed gracefully
- Write tests with mocked system info

#### 2.3 `add-sqlite-store`

**Scope**: Per-agent SQLite database for persistent session and health data.

**Schema**:
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  machine TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  ended_at TEXT,
  pid INTEGER,
  cwd TEXT
);

CREATE TABLE health_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  cpu_percent REAL,
  ram_percent REAL,
  disk_percent REAL,
  docker_containers INTEGER,
  raw_json TEXT  -- full snapshot for detail views
);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  event_type TEXT NOT NULL,  -- 'start', 'heartbeat', 'idle', 'end'
  timestamp TEXT NOT NULL,
  metadata TEXT  -- JSON blob for extensibility
);
```

**Key decisions**:
- `bun:sqlite` for the agent (native, zero-dependency)
- WAL mode for concurrent reads during health polling
- Retention: 30 days for health snapshots, 90 days for session events
- No ORM — raw SQL with typed query helpers in `@nexus/core`

**Tasks** (8-10):
- Define SQLite schema (migrations as numbered SQL files)
- Implement migration runner (apply on agent startup)
- Session CRUD operations (insert, update status, query active/recent)
- Health snapshot insert + time-series query (last N hours)
- Session event log (append-only)
- Retention cleanup (cron-like interval, delete old records)
- Write tests for all query patterns

#### 2.4 `add-session-api`

**Scope**: HTTP endpoints that expose session data from the SQLite store.

**Endpoints**:
```
GET /sessions                → Session[] (all active + recently ended)
GET /sessions?project=co     → Session[] (filtered by project)
GET /sessions?status=active  → Session[] (filtered by status)
GET /sessions/{id}           → Session (single session with full metadata)
GET /projects                → Project[] (project list with session counts)
```

**Project model**:
```typescript
interface Project {
  name: string          // Project code
  active_sessions: number
  total_sessions: number
  machines: string[]    // Hostnames with sessions for this project
}
```

**Tasks** (6-8):
- Implement route handlers for all 4 endpoints
- Add query parameter parsing and validation
- Implement project aggregation from session data
- Add response caching (1s TTL for session list, 5s for projects)
- Error responses: 404 for unknown session ID, 400 for invalid params
- Write API tests for each endpoint

#### 2.5 `add-nexus-register-hook`

**Scope**: Bun-compiled CLI binary that Claude Code hooks call on session start/stop/heartbeat.

**Usage** (CC hook config):
```json
{
  "hooks": {
    "PreToolUse": [{ "command": "nexus-register heartbeat" }],
    "SessionStart": [{ "command": "nexus-register start" }],
    "SessionStop": [{ "command": "nexus-register stop" }]
  }
}
```

**Behavior**:
- Writes session event to a watched file (same pattern as v1 `nexus-register`)
- File watcher picks up the event and relays to agent via IPC
- Compiled to single binary via `bun build --compile`

**Tasks** (5-6):
- Implement CLI with `start`, `stop`, `heartbeat` subcommands
- Write session event to `~/.config/nexus/events/` directory
- Detect project from `$CWD` and CC environment variables
- Add `bun build --compile` target producing `nexus-register` binary
- Write tests for event file creation
- Document hook installation in CC settings

#### 2.6 `add-health-history`

**Scope**: Periodic health snapshots written to SQLite, queryable as time series for sparklines.

**Tasks** (4-5):
- Implement snapshot scheduler (configurable interval, default 30s)
- Write snapshots to `health_snapshots` table
- Add time-series query: `GET /health/history?hours=24` → sparkline-ready array
- Implement retention cleanup
- Write tests for time-series queries

---

## Wave 3: Dashboard (~80 hrs)

> Goal: Web UI renders sessions, health, and projects. Read-only — no terminal streaming yet.
> Maps to ship criteria #1 (see all sessions) and #4 (view health and status).

| # | Spec ID | Title | Hours | Deps | Ship Criterion |
|---|---------|-------|------:|------|----------------|
| 3.1 | `add-dashboard-layout` | Next.js app shell: nav, layout, dark theme, design tokens | 16 | 1.1 | — |
| 3.2 | `add-session-list-page` | Dashboard page: session cards grouped by project, real-time polling | 16 | 3.1, 2.4 | #1 |
| 3.3 | `add-health-page` | Health page: machine cards with gauges, sparklines, expandable detail | 14 | 3.1, 2.2, 2.6 | #4 |
| 3.4 | `add-projects-page` | Projects page: project list with session counts and machine distribution | 10 | 3.1, 2.4 | #4 (partial) |
| 3.5 | `add-command-palette` | "/" command palette: quick-filter sessions by project, machine, status | 8 | 3.2 | #1 (REQ-DASH-4) |
| 3.6 | `add-agent-client` | Server-side HTTP client: parallel fetch from all agents, offline detection | 10 | 2.4 | — |
| 3.7 | `add-session-detail-page` | Session detail page: metadata sidebar, placeholder for terminal widget | 6 | 3.2, 3.6 | #2 (skeleton) |

### Wave 3 Exit Criteria

- [ ] Dashboard loads at `localhost:3000` with dark theme matching brand tokens
- [ ] Session cards render grouped by project with status badges (REQ-DASH-2, REQ-DASH-3)
- [ ] Health page shows machine cards with live CPU/RAM/disk gauges (REQ-HEALTH-2)
- [ ] Health sparklines render 24-hour trend data (REQ-HEALTH-3)
- [ ] Offline machines show grayed card with "Last seen N ago" (REQ-HEALTH-5)
- [ ] Projects page lists projects with active session counts (REQ-PROJECT-1)
- [ ] Command palette filters sessions (REQ-DASH-4)
- [ ] Empty state: "No active sessions across N machines" (REQ-DASH-5)

### Spec Details

#### 3.1 `add-dashboard-layout`

**Scope**: Next.js App Router shell with navigation, dark theme, and design tokens from brand/.

**Implementation**:
- App Router with layout.tsx (nav sidebar + main content area)
- CSS custom properties from `brand/tokens.css`
- Geist Sans + Geist Mono fonts
- Phosphor Icons (line weight 1.5px)
- Navigation: Dashboard, Health, Projects, Settings
- Keyboard navigation: j/k for lists, "/" for command palette, Escape to close overlays
- Responsive: optimized for 1440px+ desktop, functional at 1024px

**Tasks** (10-12):
- Configure Next.js with App Router, Turbopack
- Import design tokens as CSS custom properties
- Build layout component: sidebar nav + main area
- Implement dark theme (single theme, no toggle needed)
- Add Geist fonts via `next/font`
- Set up Phosphor Icons
- Build reusable components: Card, Badge, StatusDot, Gauge, Sparkline
- Implement keyboard navigation hooks (j/k, /, Escape)
- Add loading skeleton components
- Write component tests

#### 3.2 `add-session-list-page`

**Scope**: Dashboard home page rendering session cards grouped by project.

**Data flow**: Server Action → `@nexus/agent-client` → parallel fetch from all agents → render.

**Session card contents** (per REQ-DASH-3):
- Project name (header, collapsible group)
- Machine hostname (badge)
- Status: active (blue dot), idle (yellow dot), ended (gray dot)
- Duration (e.g., "2h 14m")
- Last activity (relative timestamp, e.g., "3m ago")

**Interactions**:
- Click card → navigate to `/session/{id}`
- Click project header → collapse/expand group
- Real-time: poll every 5s (WebSocket upgrade in Wave 4)

**Tasks** (10-12):
- Build session card component
- Build project group component (collapsible)
- Implement Server Action for fetching sessions from all agents
- Add polling (5s interval) for real-time updates
- Implement empty state (REQ-DASH-5)
- Add status badge component (active/idle/ended)
- Add relative timestamp formatter
- Implement session sorting: active first, then by last activity
- Write component tests
- Write E2E test: dashboard renders sessions from 2 agents

#### 3.3 `add-health-page`

**Scope**: Machine health monitoring page with gauges, sparklines, and expandable detail.

**Machine card contents** (per REQ-HEALTH-2):
- Hostname
- Uptime
- CPU % (gauge + sparkline)
- RAM % (gauge + sparkline)
- Disk % (gauge + sparkline, warning color at >80%)
- Docker container count

**Expanded detail** (per REQ-HEALTH-4):
- Per-process CPU/RAM top 10
- Disk usage by mount point
- Network interface stats

**Offline state** (per REQ-HEALTH-5):
- Grayed card appearance
- "Last seen {duration} ago"
- Last-known metric snapshot displayed

**Tasks** (8-10):
- Build Gauge component (circular or bar, with color thresholds)
- Build Sparkline component (SVG, 24-hour window)
- Build machine card component
- Implement expanded detail panel
- Add offline machine detection and display
- Implement Server Action for parallel health fetch
- Add warning thresholds: yellow >80%, red >95%
- Write component tests
- Write E2E test: health page with 3 agents (2 online, 1 offline)

#### 3.4 `add-projects-page`

**Scope**: Project overview with session counts and machine distribution.

**Project card contents** (per REQ-PROJECT-1):
- Project name
- Active session count
- Total session count (active + recent)
- Machine distribution (list of hostnames with sessions)

**Interactions**:
- Click project → navigate to `/projects/{name}` (filtered session list)

**Tasks** (6-8):
- Build project card component
- Implement Server Action for project aggregation
- Build project detail page (`/projects/{name}`) with filtered session list
- Add session count badges
- Write component tests

#### 3.5 `add-command-palette`

**Scope**: "/" triggered command palette for quick session filtering.

**Behavior** (per REQ-DASH-4):
- Trigger: "/" key press on dashboard
- Search: fuzzy match across project name, machine hostname, session status
- Results: session cards matching the query
- Navigation: arrow keys + Enter to select, Escape to close
- Dismiss: Escape or click outside

**Tasks** (5-6):
- Build command palette overlay component
- Implement fuzzy search across session metadata
- Add keyboard navigation (arrows, Enter, Escape)
- Wire to "/" keypress on dashboard page
- Write component tests

#### 3.6 `add-agent-client`

**Scope**: Server-side HTTP client that fetches from all configured agents in parallel with
offline detection.

**Implementation**:
- Read `agents.toml` (or dashboard-side config) for agent endpoints
- Parallel `Promise.allSettled` for resilience
- Timeout: 3s per agent
- Offline detection: mark agents that fail to respond, track "last seen" timestamp
- Caching: 1s TTL for session data, 5s for health data

**Tasks** (6-8):
- Implement agent client with parallel fetch
- Add timeout and retry logic (1 retry, 1s delay)
- Implement offline tracking with "last seen" timestamps
- Add response merging (sessions from all agents into unified list)
- Cache layer with TTL
- Write tests with mocked agents (online, offline, slow)

#### 3.7 `add-session-detail-page`

**Scope**: Session detail page skeleton — metadata sidebar, placeholder for terminal widget
(terminal added in Wave 4).

**Page layout**:
- Left: terminal placeholder (gray box with "Terminal streaming available in next release")
- Right sidebar: session metadata (project, machine, status, duration, PID, CWD)
- Top bar: session ID, back navigation, stream/interact toggle (disabled until Wave 4)

**Tasks** (4-5):
- Build session detail page layout
- Implement metadata sidebar
- Add terminal placeholder component
- Wire routing from session card click
- Write component tests

---

## Wave 4: Interaction (~50 hrs)

> Goal: Full terminal streaming and interactive control via WebSocket. This wave delivers
> ship criteria #2 (stream real-time) and #3 (send input).

| # | Spec ID | Title | Hours | Deps | Ship Criterion |
|---|---------|-------|------:|------|----------------|
| 4.1 | `add-terminal-stream-ws` | Agent WebSocket endpoint: `/sessions/{id}/stream` (read-only PTY output) | 14 | 2.1 | #2 (backend) |
| 4.2 | `add-terminal-interact-ws` | Agent WebSocket endpoint: `/sessions/{id}/interact` (bidirectional PTY relay) | 14 | 4.1 | #3 (backend) |
| 4.3 | `add-xterm-widget` | Dashboard xterm.js terminal widget with WebSocket connection | 12 | 3.7, 4.1 | #2 (frontend) |
| 4.4 | `add-interactive-mode` | Dashboard interactive mode: stdin relay, resize events, Ctrl+C forwarding | 10 | 4.3, 4.2 | #3 (frontend) |

### Wave 4 Exit Criteria

- [ ] Clicking a session card opens xterm.js with real-time terminal output (AC-4)
- [ ] Scroll-back buffer preserves terminal history (AC-5)
- [ ] "Interact" button upgrades to bidirectional terminal relay (REQ-STREAM-5)
- [ ] Typing in interactive mode sends keystrokes to remote PTY within 100ms (AC-7)
- [ ] Ctrl+C sends 0x03 to remote PTY (AC-8)
- [ ] Browser resize triggers SIGWINCH on remote PTY (AC-9)
- [ ] Agent offline during stream shows "Machine offline — last seen N ago" (AC-6)
- [ ] ANSI escape sequences render correctly in xterm.js (REQ-INTERACT-4)

### Spec Details

#### 4.1 `add-terminal-stream-ws`

**Scope**: WebSocket endpoint on the agent that streams PTY output from a CC session.

**Protocol**:
```
Client connects: WS /sessions/{id}/stream
Server sends: binary frames (raw PTY stdout bytes)
Server sends: JSON control frames { "type": "session_ended" | "error", ... }
Client sends: JSON control frames { "type": "ping" } (keepalive)
```

**Implementation**:
- Bun WebSocket server (native `Bun.serve` WebSocket support)
- Attach to CC session PTY via `/proc/{pid}/fd/` or `script`-based capture
- Buffer last 10,000 lines for scroll-back on connect
- Broadcast to multiple viewers (fan-out)
- Clean disconnect on session end

**Tasks** (8-10):
- Implement WebSocket upgrade handler for `/sessions/{id}/stream`
- Implement PTY output capture (read from session terminal)
- Add scroll-back buffer (ring buffer, 10K lines)
- Implement fan-out to multiple connected clients
- Add keepalive ping/pong
- Handle session end gracefully (notify all viewers)
- Handle invalid session ID (404 equivalent)
- Write integration tests: connect, receive output, verify ordering

#### 4.2 `add-terminal-interact-ws`

**Scope**: Bidirectional WebSocket that relays stdin to and stdout from a CC session PTY.

**Protocol**:
```
Client connects: WS /sessions/{id}/interact
Server sends: binary frames (raw PTY stdout bytes)
Client sends: binary frames (raw stdin bytes — keystrokes, control chars)
Client sends: JSON control frames { "type": "resize", "cols": 120, "rows": 40 }
Server sends: JSON control frames { "type": "session_ended" | "error", ... }
```

**Implementation**:
- Extends stream endpoint with write capability
- Write to PTY stdin via file descriptor
- Handle resize events → `SIGWINCH` to PTY
- One interactive client at a time (mutex) — multiple viewers can stream read-only
- Latency target: <100ms keypress-to-screen on Tailscale (REQ-INTERACT-5)

**Tasks** (8-10):
- Implement bidirectional WebSocket handler
- Implement PTY stdin write (raw bytes)
- Implement resize event handling (SIGWINCH)
- Add interactive session mutex (one writer, many readers)
- Handle control characters (Ctrl+C = 0x03, Ctrl+D = 0x04, etc.)
- Measure and optimize latency (target <100ms)
- Handle writer disconnect gracefully (revert to read-only for viewers)
- Write integration tests: connect, send input, verify echo

#### 4.3 `add-xterm-widget`

**Scope**: Browser-side xterm.js terminal component connected to agent WebSocket.

**Dependencies**: `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`

**Implementation**:
- React component wrapping xterm.js
- WebSocket connection to agent `/sessions/{id}/stream`
- Auto-fit to container size
- WebGL renderer for performance
- Scroll-back preservation (client-side buffer from server scroll-back)
- Connection status indicator: connected (green), reconnecting (yellow), disconnected (red)

**Tasks** (7-9):
- Install xterm.js dependencies
- Build XTerm React component with lifecycle management
- Implement WebSocket connection to stream endpoint
- Add auto-fit on container resize
- Add WebGL renderer with fallback to canvas
- Implement connection status indicator
- Handle reconnection on disconnect (3 retries, exponential backoff)
- Write component tests

#### 4.4 `add-interactive-mode`

**Scope**: Upgrade from read-only streaming to full interactive terminal control in the dashboard.

**Implementation**:
- "Interact" button on session detail page
- Upgrades WebSocket connection from stream to interact endpoint
- Captures all keyboard input and forwards as raw bytes
- Forwards browser resize events as JSON control frames
- Shows mode indicator: "Streaming (read-only)" vs "Interactive"
- Escape hatch: button to disconnect interactive mode

**Tasks** (6-8):
- Implement stream/interact toggle in session detail page
- Add keyboard capture (prevent browser shortcuts in terminal focus)
- Forward resize events to WebSocket
- Implement mode indicator UI
- Add disconnect button for interactive mode
- Handle edge cases: agent goes offline during interaction, session ends during interaction
- Write E2E test: open session, switch to interactive, type command, verify output

---

## Wave 5: Polish (~30 hrs)

> Goal: Carry-forward features from Rust v1 (notifications, credentials), analytics layer,
> and cross-machine integration testing. Final acceptance testing against all 14 ACs.

| # | Spec ID | Title | Hours | Deps | Ship Criterion |
|---|---------|-------|------:|------|----------------|
| 5.1 | `add-notification-system` | Meeting-aware notification queuing (port from Rust v1) | 10 | 2.3 | — |
| 5.2 | `add-credential-pool` | Shared credential management across sessions (port from Rust v1) | 8 | 2.3, 2.4 | — |
| 5.3 | `add-settings-page` | Settings page: agent configuration, connection status, notification prefs | 6 | 3.1 | — |
| 5.4 | `add-acceptance-tests` | E2E acceptance test suite covering all 14 ACs from the PRD | 6 | All | All |

### Wave 5 Exit Criteria

- [ ] Meeting-aware notification queuing works (buffer during meetings, flush after)
- [ ] Credential pool accessible to sessions via agent API
- [ ] Settings page renders agent list with connection status
- [ ] All 14 acceptance criteria (AC-1 through AC-14) pass
- [ ] Cross-machine test: 2+ agents on different Tailscale machines, dashboard aggregates correctly
- [ ] `bun build --compile` produces working `nexus-agent` binary
- [ ] systemd service survives agent restart and machine reboot

### Spec Details

#### 5.1 `add-notification-system`

**Scope**: Port meeting-aware notification queuing from Rust to Bun/TS.

**Behavior** (carry forward from v1):
- Detect meeting state (calendar integration or manual toggle)
- During meetings: buffer notifications in SQLite
- After meetings: flush buffered notifications
- Notification channels: desktop (node-notifier), TTS (ElevenLabs API), Slack webhook
- Project-aware routing: different notification rules per project

**Tasks** (6-8):
- Define notification model in `@nexus/core`
- Implement notification buffer in SQLite
- Port meeting detection logic
- Implement desktop notification channel
- Implement TTS notification channel (ElevenLabs)
- Add project-aware routing rules
- Write tests for buffer/flush lifecycle

#### 5.2 `add-credential-pool`

**Scope**: Shared credential management — pool of API credentials rotated across CC sessions.

**Behavior** (carry forward from v1):
- Agent manages a pool of credentials (e.g., Claude API keys)
- Sessions lease credentials via agent API
- Automatic rotation on rate limit or expiry
- SQLite tracks credential state (available, leased, cooldown)

**Tasks** (5-6):
- Define credential model and pool logic
- Implement lease/release API endpoints
- Add automatic rotation on rate limit detection
- SQLite persistence for credential state
- Write tests for pool lifecycle

#### 5.3 `add-settings-page`

**Scope**: Dashboard settings page for agent configuration and preferences.

**Contents**:
- Agent list with connection status (online/offline, last seen)
- Add/remove agent configuration
- Notification preferences (channels, per-project rules)
- Polling interval configuration
- Keyboard shortcut reference

**Tasks** (4-5):
- Build settings page layout
- Implement agent list with status indicators
- Add notification preference form
- Persist settings to dashboard SQLite
- Write component tests

#### 5.4 `add-acceptance-tests`

**Scope**: E2E test suite validating all 14 acceptance criteria from prd.md section 4.2.

**Test matrix**:

| AC | Test |
|----|------|
| AC-1 | 3 agents, 5 sessions → all render within 2s |
| AC-2 | 0 sessions, 3 agents → empty state message |
| AC-3 | 4 projects → "/" filter isolates one project |
| AC-4 | Active session → stream connects within 500ms |
| AC-5 | 200 lines output → scroll-back to line 1 |
| AC-6 | Agent goes offline → "Machine offline" within 5s |
| AC-7 | Interactive mode → "hello" in stdin within 100ms |
| AC-8 | Ctrl+C → 0x03 sent, interrupt result renders |
| AC-9 | Resize to 120x40 → SIGWINCH propagated |
| AC-10 | 3 agents → 3 health cards with live metrics |
| AC-11 | Agent offline 12min → grayed card, "Last seen 12m ago" |
| AC-12 | 92% disk → warning color gauge |
| AC-13 | Project "co" → 2 sessions on 2 machines |
| AC-14 | Click session from project view → streaming terminal |

**Tasks** (4-5):
- Set up E2E test framework (Playwright for dashboard, Bun test for agent)
- Implement test agent mocks (configurable responses)
- Write all 14 AC tests
- Add CI pipeline configuration

---

## Dependency Graph

```
Wave 1                    Wave 2                    Wave 3                    Wave 4              Wave 5
───────                   ───────                   ───────                   ───────             ───────

1.1 scaffold ──────┬──── 2.1 session-detect ─────── 3.2 session-list ──────── 4.3 xterm ────────  5.4 acceptance
                   │          │                          │                        │
1.2 agent-skel ───┤     2.3 sqlite-store ──┬──── 3.6 agent-client         4.4 interactive       5.1 notifications
       │          │          │              │         │                        │
1.3 rust-watcher ─┘     2.2 health-mon ────┼──── 3.3 health-page         4.1 stream-ws ────────  5.2 credential-pool
                             │              │         │                        │
1.4 service-cfg             2.4 session-api ┘    3.4 projects-page        4.2 interact-ws        5.3 settings-page
                             │                        │
1.5 config-loader           2.5 register-hook    3.5 cmd-palette
                             │
                            2.6 health-history   3.7 session-detail
```

---

## Beads Triage: 50 Open Issues

The Rust v1 codebase has 50 open beads issues. These fall into three categories:

| Category | Action | Estimated Count |
|----------|--------|----------------:|
| **Rust-specific** (TUI rendering, gRPC, protobuf, ratatui) | Close as `wontfix` — superseded by TS rewrite | ~30 |
| **Architecture-portable** (session detection, health monitoring, notifications) | Reframe as v2 specs — requirements carry forward, implementation changes | ~12 |
| **Feature requests** (collaboration, analytics, credential pool) | Map to Wave 4-5 specs or create new v2 issues | ~8 |

**Action**: Run `bd list --status open` during Wave 1 scaffold to triage all 50 issues. Close
Rust-specific issues in bulk, reframe portable ones as v2 beads under new epic.

---

## Risk Mitigation per Wave

| Wave | Primary Risk | Mitigation |
|------|-------------|------------|
| 1 | Bun binary compilation edge cases | Test `bun build --compile` early with real HTTP server; fall back to Node.js if critical |
| 2 | Session detection reliability (IPC bridge) | Rust watcher is battle-tested; IPC protocol is simple JSON lines; test with real CC sessions |
| 3 | Dashboard performance with many sessions | Server-side rendering + 5s polling; upgrade to WebSocket push in Wave 4 if needed |
| 4 | WebSocket terminal relay latency | Study GoTTY architecture; measure on Tailscale early; binary frames minimize overhead |
| 5 | Notification port complexity | Meeting detection is the hard part; start with manual toggle, add calendar later |

---

## Hour Allocation Summary

| Wave | Specs | Hours | Cumulative |
|------|------:|------:|-----------:|
| 1: Foundation | 5 | 40 | 40 |
| 2: Core | 6 | 60 | 100 |
| 3: Dashboard | 7 | 80 | 180 |
| 4: Interaction | 4 | 50 | 230 |
| 5: Polish | 4 | 30 | 260 |
| **Total** | **26** | **260** | |

Matches the financial-projections.md estimate of ~260 AI-assisted hours.

---

## Ship Criteria Traceability

| Ship Criterion | Wave | Specs | Acceptance Criteria |
|---------------|------|-------|-------------------|
| #1: See all sessions | 2 + 3 | 2.1, 2.4, 2.5, 3.2, 3.5, 3.6 | AC-1, AC-2, AC-3 |
| #2: Stream real-time | 4 | 4.1, 4.3 | AC-4, AC-5, AC-6 |
| #3: Send input | 4 | 4.2, 4.4 | AC-7, AC-8, AC-9 |
| #4: Health + status | 2 + 3 | 2.2, 2.6, 3.3, 3.4 | AC-10, AC-11, AC-12, AC-13, AC-14 |

All four must-do features from scope-lock.md are covered. No ship criterion is deferred.
