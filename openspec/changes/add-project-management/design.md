# Design: Add Project Management

## Architecture Overview

Three system layers are touched: the Rust agent (new HTTP endpoints), the TypeScript core (types + agent-client), and the Next.js dashboard (UI components + server actions).

```
Dashboard (Next.js)             Agent (Rust)
─────────────────────           ──────────────────────────────
ProjectsPoller                  GET /projects/discovered
  └─ fetchDiscoveredProjects()  ← scans $NEXUS_PROJECTS_DIR
                                  merges SessionRegistry counts

ProjectCard                     POST /session/start
  └─ startSession()             ← tmux new-window -d -c <path>
  └─ optimistic "Starting..."     tmux send-keys 'claude' Enter

Settings/AgentManagement        GET /agent/self
  └─ fetchAgentConfig()         ← returns { name, host, port,
  └─ dashboard.json CRUD            role, projects_dir }

Settings/CommandsBrowser        GET /commands
  └─ fetchAgentCommands()       ← existing endpoint, all commands
```

## Key Design Decisions

### 1. projects_dir as env var (not TOML field)
`NEXUS_PROJECTS_DIR` is read at startup and stored in `AppState`. This keeps the Rust agent stateless — no file writes. The dashboard displays the resolved value via `/agent/self`. Future work can promote this to a writable TOML field.

### 2. dashboard.json for agent CRUD
Writing back to `~/.env` or `NEXUS_AGENTS` requires a shell process. Instead, the Next.js server writes `~/.config/nexus/dashboard.json` (same config dir) which `get-client.ts` reads alongside `NEXUS_AGENTS`. This avoids service restarts and shell escaping issues.

**Merge priority:** `NEXUS_AGENTS` > `dashboard.json` (name deduplication).

**dashboard.json schema:**
```json
{
  "agents": [
    { "name": "server", "host": "100.x.x.x", "port": 7400, "projects_dir": "~/dev" }
  ]
}
```

### 3. Tmux session naming
Session name pattern: `<project>-<unix-ms-timestamp>`. Guarantees uniqueness across rapid successive starts. The session name is returned to the dashboard in `POST /session/start` response for potential future attach-by-name routing.

### 4. ProjectsPoller data source change
`fetchDiscoveredProjects()` replaces the session-derived project list. The old approach (deriving projects from session grouping) is subsumed: `GET /projects/discovered` merges session counts from the Rust registry, so the frontend always sees a unified list regardless of whether sessions are running.

The `ProjectCard` receives a `DiscoveredProject` (which has `path`) instead of the old `Project` type. The `path` field is needed to pass to `POST /session/start`.

### 5. Commands Browser — source detection
The existing `CommandInfo` in `nexus_core::command` has a `file` field (full path). Source detection:
- Contains `/.claude/commands/` without a project prefix → **Global**
- Contains `/<project>/.claude/commands/` → **Project** (extract project name from path)

No new Rust logic needed; the grouping is done client-side in the React component.

## Data Flow: Start Session

```
User clicks "Start Session" on nx card
  │
  ▼
ProjectCard sets local state { starting: true }
  │
  ▼
startSession({ agent: "homelab", project: "nx", path: "/home/user/dev/nx" })
  │  (Next.js server action)
  ▼
agent-client.startSession(agentConfig, { project, path })
  │  POST http://homelab:7400/session/start
  ▼
Rust handler: which_tmux → check → tmux new-window → send-keys
  │  returns { session_name: "nx-1234567890", started: true }
  ▼
Server action returns success
  │
  ▼
ProjectCard: clears optimistic state (poller handles session count update)
```

## File Map

| File | Change type |
|------|-------------|
| `crates/nexus-agent/src/http_handlers/sessions.rs` | NEW — start handler |
| `crates/nexus-agent/src/http_handlers/agent.rs` | NEW — self handler |
| `crates/nexus-agent/src/http_handlers/mod.rs` | MODIFIED — register routes |
| `crates/nexus-agent/src/main.rs` | MODIFIED — read `NEXUS_PROJECTS_DIR` into AppState |
| `crates/nexus-agent/src/http_handlers/projects.rs` | MODIFIED — add `GET /projects/discovered` |
| `deploy/nexus-agent.service` | MODIFIED — add `NEXUS_PROJECTS_DIR` env |
| `packages/core/src/types/project.ts` | MODIFIED — add `DiscoveredProject` |
| `packages/core/src/config.ts` | MODIFIED — add `projects_dir` to schema |
| `packages/core/src/index.ts` | MODIFIED — export `DiscoveredProject` |
| `apps/nextjs/src/lib/agent-client.ts` | MODIFIED — 4 new methods |
| `apps/nextjs/src/lib/get-client.ts` | MODIFIED — merge `dashboard.json` |
| `apps/nextjs/src/app/actions/projects.ts` | MODIFIED — use discovered |
| `apps/nextjs/src/app/actions/sessions.ts` | MODIFIED — add startSession |
| `apps/nextjs/src/app/actions/settings.ts` | MODIFIED — add agent config actions |
| `apps/nextjs/src/components/ProjectCard.tsx` | MODIFIED — Start Session button |
| `apps/nextjs/src/components/ProjectsPoller.tsx` | MODIFIED — DiscoveredProject type |
| `apps/nextjs/src/components/AgentManagementPanel.tsx` | NEW |
| `apps/nextjs/src/components/CommandsBrowserPanel.tsx` | NEW |
| `apps/nextjs/src/app/settings/page.tsx` | MODIFIED — add panels |
