# User Stories — Nexus v2

> Generated: 2026-04-03
> Source: docs/plan/v2/scope-lock.md

---

## Personas

### 1. Leo — Lead Developer / Power User

| Field | Detail |
|-------|--------|
| **Name** | Leo |
| **Role** | Lead developer, project owner of 14 T3 projects |
| **Goals** | See all active Claude Code sessions across 3-5 machines at a glance; stream or take over any session from any machine without SSH; spot resource bottlenecks before they crater a build |
| **Pain Points** | Currently tmux-hops between machines to check session state; no single view of "what is every AI agent doing right now"; health problems (disk full, OOM) discovered after the fact |
| **Technical Comfort** | Power user — keyboard-first, lives in terminal, will customize keybindings |

### 2. Mateo — Team Developer

| Field | Detail |
|-------|--------|
| **Name** | Mateo |
| **Role** | Full-stack engineer on the same Tailscale network |
| **Goals** | Watch Leo's sessions to learn patterns; send follow-up instructions to a session Leo started without interrupting him; check project health across the team's machines |
| **Pain Points** | Has no visibility into sessions on other machines; asks Leo "is that deploy done?" via Slack instead of seeing it directly; can't resume or contribute to sessions started by teammates |
| **Technical Comfort** | Comfortable — uses CLI daily but prefers a web UI for dashboards |

### 3. Priya — Part-Time Contributor

| Field | Detail |
|-------|--------|
| **Name** | Priya |
| **Role** | Contractor / part-time dev, limited hours per week |
| **Goals** | Quickly find which sessions are relevant to her assigned projects; stream a session to understand context before picking up work; see machine health to know if her builds will be slow |
| **Pain Points** | Joins mid-sprint with no context on what sessions ran; wastes time asking teammates what happened; unfamiliar with the full machine topology |
| **Technical Comfort** | Comfortable — prefers browser-based tools over raw terminal |

---

## User Flows

### Flow 1: Dashboard Overview (Leo)

> v2 Must-Do journey #1 — "See all active Claude Code sessions across all machines"

```mermaid
sequenceDiagram
    participant Leo as Leo (Lead Dev)
    participant Dash as Web Dashboard
    participant Agents as Nexus Agents (N machines)

    Leo->>Dash: Opens dashboard in browser
    Dash->>Agents: GET /sessions (parallel to all agents)
    Agents-->>Dash: Session list + metadata per machine
    Dash-->>Leo: Renders session cards grouped by project

    Note over Leo,Dash: Sessions show: project, machine, status, duration, last activity

    Leo->>Dash: Clicks project group header to collapse/expand
    Dash-->>Leo: Filters view to selected project sessions

    Leo->>Dash: Presses "/" to open command palette
    Dash-->>Leo: Quick-filter sessions by project, machine, or status

    alt No sessions active
        Dash-->>Leo: Empty state — "No active sessions across 3 machines"
    end
```

### Flow 2: Stream a Session (Mateo)

> v2 Must-Do journey #2 — "Stream any session's output in real time"

```mermaid
sequenceDiagram
    participant Mateo as Mateo (Team Dev)
    participant Dash as Web Dashboard
    participant Agent as Nexus Agent (Leo's machine)

    Mateo->>Dash: Clicks session card from dashboard
    Dash->>Agent: WS /sessions/{id}/stream (upgrade to WebSocket)
    Agent-->>Dash: Terminal output stream (real-time bytes)
    Dash-->>Mateo: Renders terminal output in xterm.js widget

    Note over Mateo,Dash: Read-only stream — sees exactly what the session produces

    Mateo->>Dash: Scrolls back through terminal history
    Dash-->>Mateo: Buffered output (scroll-back preserved)

    Mateo->>Dash: Clicks "Interact" button to switch to interactive mode
    Dash->>Agent: WS upgrade to bidirectional (interactive control)
    Agent-->>Dash: Confirms interactive mode
    Dash-->>Mateo: Input field becomes active — can type commands

    alt Agent unreachable
        Dash-->>Mateo: "Machine offline — last seen 3m ago"
    end
```

### Flow 3: Send Input to a Session (Leo)

> v2 Must-Do journey #3 — "Send input to any session (full interactive control)"

```mermaid
sequenceDiagram
    participant Leo as Leo (Lead Dev)
    participant Dash as Web Dashboard
    participant Agent as Nexus Agent (target machine)
    participant CC as Claude Code Session

    Leo->>Dash: Opens session detail, clicks "Interact"
    Dash->>Agent: WS /sessions/{id}/interact (bidirectional)
    Agent-->>Dash: Interactive session established

    Leo->>Dash: Types instruction in terminal input
    Dash->>Agent: WS send (stdin bytes)
    Agent->>CC: Writes to session PTY stdin
    CC-->>Agent: Output from Claude Code
    Agent-->>Dash: WS send (stdout bytes)
    Dash-->>Leo: Real-time terminal update

    Note over Leo,Dash: Full terminal relay — keyboard input, ANSI escapes, resize events

    Leo->>Dash: Resizes browser window
    Dash->>Agent: WS send (resize event: cols x rows)
    Agent->>CC: PTY resize (SIGWINCH)

    Leo->>Dash: Presses Ctrl+C
    Dash->>Agent: WS send (0x03 interrupt)
    Agent->>CC: Forwards interrupt to PTY
    CC-->>Agent: Interrupted output
    Agent-->>Dash: WS send (output)
    Dash-->>Leo: Terminal shows interrupt result
```

### Flow 4: Machine Health Check (Priya)

> v2 Must-Do journey #4 — "View machine health and project status"

```mermaid
sequenceDiagram
    participant Priya as Priya (Contributor)
    participant Dash as Web Dashboard
    participant Agents as Nexus Agents (all machines)

    Priya->>Dash: Navigates to Health page
    Dash->>Agents: GET /health (parallel to all agents)
    Agents-->>Dash: CPU, RAM, disk, Docker stats per machine

    Dash-->>Priya: Machine cards with gauges and sparklines

    Note over Priya,Dash: Each card: hostname, uptime, CPU %, RAM %, disk %, Docker containers

    Priya->>Dash: Clicks machine card for detail
    Dash-->>Priya: Expanded view — per-process breakdown, disk by mount, network

    alt Machine offline
        Dash-->>Priya: Grayed card — "Last seen 12m ago" with last-known metrics
    end

    Priya->>Dash: Navigates to Projects page
    Dash->>Agents: GET /sessions + GET /projects (parallel)
    Agents-->>Dash: Session counts and status per project
    Dash-->>Priya: Project list with active session count, machines involved
```

### Flow 5: Project Context Discovery (Priya)

> Cross-cutting journey — Priya onboards to a project mid-sprint

```mermaid
sequenceDiagram
    participant Priya as Priya (Contributor)
    participant Dash as Web Dashboard
    participant Agents as Nexus Agents

    Priya->>Dash: Navigates to Projects page
    Dash->>Agents: GET /projects (parallel)
    Agents-->>Dash: Project list with session counts
    Dash-->>Priya: Project cards — name, active sessions, machines

    Priya->>Dash: Clicks project "co" (her assignment)
    Dash->>Agents: GET /sessions?project=co
    Agents-->>Dash: All sessions for project "co" across machines
    Dash-->>Priya: Session list filtered to "co" — active and recent

    Priya->>Dash: Clicks active session to stream
    Dash->>Agents: WS /sessions/{id}/stream
    Agents-->>Dash: Terminal output stream
    Dash-->>Priya: Reads session context in real time

    Priya->>Dash: Clicks "Interact" to contribute
    Dash->>Agents: WS upgrade to bidirectional
    Dash-->>Priya: Can now send input to the session
```

---

## Page Inventory

| Flow Step | Wireframe Page | Primary Persona |
|-----------|---------------|-----------------|
| Entry point / session overview | `index.html` (Dashboard) | Leo |
| Session detail + stream + interact | `pages/session.html` | Mateo, Leo |
| Machine health overview | `pages/health.html` | Priya |
| Project list + filtering | `pages/projects.html` | Priya |
| Project detail (sessions for one project) | `pages/project-detail.html` | Priya, Mateo |
| Settings (agent config, preferences) | `pages/settings.html` | Leo |

---

## Wireframes

Wireframe prototype at: `docs/plan/v2/wireframes/`

- `index.html` — Dashboard (navigation hub + session overview)
- `pages/session.html` — Session detail with terminal stream
- `pages/health.html` — Machine health monitoring
- `pages/projects.html` — Project overview
- `pages/project-detail.html` — Single project session list
- `pages/settings.html` — Agent configuration
- `styles.css` — Shared styles, dark mode, responsive breakpoints
