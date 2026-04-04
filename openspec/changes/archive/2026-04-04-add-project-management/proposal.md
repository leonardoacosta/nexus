# Proposal: Add Project Management

## Change ID
`add-project-management`

## Summary
Enhances the Projects page with directory-based project discovery and one-click session launching; adds an Agent Management console to Settings with agent CRUD, frontmatter inspection, and command browsing.

## Context
- Extends: `crates/nexus-agent/src/http_handlers/`, `crates/nexus-core/`, `packages/core/src/config.ts`, `packages/core/src/types/project.ts`, `apps/nextjs/src/lib/agent-client.ts`, `apps/nextjs/src/components/ProjectsPoller.tsx`, `apps/nextjs/src/components/ProjectCard.tsx`, `apps/nextjs/src/app/settings/`
- Related: `deploy-dashboard-homelab` (homelab service infra), `fix-tsconfig-project-refs` (TS config baseline)

## Motivation
The Projects page currently only shows projects with active sessions — it is empty when no Claude Code sessions are running. There is no way to start a session from the dashboard, and agent configuration requires SSH access to edit config files manually.

## Requirements

### Req-1: Directory-Based Project Discovery
Each agent exposes `GET /projects/discovered` which recursively scans a configured `projects_dir` (read from `NEXUS_PROJECTS_DIR` env var, default `~/dev`) up to a configurable depth (query param `depth`, default 1, max 3) and returns matching subdirectories as discovered projects merged with live session counts from the session registry. A directory is included if it contains a `.git` directory or a `package.json`/`Cargo.toml` at its root (project marker heuristic). The Projects page uses this endpoint instead of deriving projects from sessions alone.

### Req-2: One-Click Session Launch
Each agent exposes `POST /session/start { project: string, path: string }` which spawns a new detached tmux window in the project directory and runs `claude`. The Projects page shows a "Start Session" button on each `ProjectCard`; clicking it marks the card as "Starting…" optimistically while the poller picks up the new session within ~2 s.

### Req-3: Agent Management Console
The Settings page includes an Agent Management section that reads each agent's self-config from `GET /agent/self` and displays full frontmatter (name, host, port, user, role, projects_dir). New agents can be added (persisted to `~/.config/nexus/dashboard.json` on the homelab, merged with `NEXUS_AGENTS` at runtime) and existing agents can be removed.

### Req-4: Commands Editor
The Settings page includes a Commands Browser section that fetches `GET /commands` from each connected agent and displays commands grouped by source: global (`~/.claude/commands/`) vs project-level (`.claude/commands/` relative to the project). Selecting a command opens an inline editor showing the full file content (frontmatter + body). Saving calls `PUT /commands/:name` on the agent, which writes the updated content back to disk atomically.

## Scope
- **IN**: `NEXUS_PROJECTS_DIR` env var support in agent, `/projects/discovered` with recursive depth scan + project-marker heuristic, `/session/start` endpoint, `/agent/self` endpoint, `PUT /commands/:name` write endpoint, ProjectCard Start Session button with optimistic UI, agent CRUD in Settings (add/remove/view frontmatter), commands editor with inline edit + save, global vs project-level grouping
- **OUT**: Writing agent config back to remote `agents.toml` via API, session routing across multiple agents for a single start request

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-agent` | 3 new HTTP endpoints, env var read at startup |
| `deploy/nexus-agent.service` | Add `NEXUS_PROJECTS_DIR=~/dev` to environment block |
| `packages/core` | `DiscoveredProject` type, optional `projects_dir` on `AgentConfigSchema` |
| `apps/nextjs/src/lib/agent-client.ts` | 4 new methods |
| `apps/nextjs/src/app/actions/` | 2 updated/new server actions |
| `apps/nextjs/src/components/` | `ProjectCard`, `ProjectsPoller`, 2 new Settings panels |
| `apps/nextjs/src/app/settings/` | 2 new sections in layout |

## Risks
| Risk | Mitigation |
|------|-----------|
| tmux not installed on agent machine | `POST /session/start` returns 503 with `{ error: "tmux not found" }` |
| Recursive scan hits symlink cycle or slow filesystem | Max depth 3, skip symlinks, 5 s total scan timeout |
| `projects_dir` has thousands of matching entries | Cap response at 200 after project-marker filter; return `truncated: true` flag |
| `dashboard.json` diverges from `NEXUS_AGENTS` | Dashboard merges both; `NEXUS_AGENTS` takes precedence on name collision |
| Start Session called while tmux session name collides | Use `<project>-<timestamp>` as session name to avoid conflicts |
| Command write overwrites file with corrupt content | Atomic write via tmp file + rename; validate non-empty content before write |
