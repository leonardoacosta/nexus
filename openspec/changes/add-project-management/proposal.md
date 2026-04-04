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
Each agent exposes `GET /projects/discovered` which scans a configured `projects_dir` (read from `NEXUS_PROJECTS_DIR` env var, default `~/dev`) and returns all immediate subdirectories as discovered projects merged with live session counts from the session registry. The Projects page uses this endpoint instead of deriving projects from sessions alone.

### Req-2: One-Click Session Launch
Each agent exposes `POST /session/start { project: string, path: string }` which spawns a new detached tmux window in the project directory and runs `claude`. The Projects page shows a "Start Session" button on each `ProjectCard`; clicking it marks the card as "Starting…" optimistically while the poller picks up the new session within ~2 s.

### Req-3: Agent Management Console
The Settings page includes an Agent Management section that reads each agent's self-config from `GET /agent/self` and displays full frontmatter (name, host, port, user, role, projects_dir). New agents can be added (persisted to `~/.config/nexus/dashboard.json` on the homelab, merged with `NEXUS_AGENTS` at runtime) and existing agents can be removed.

### Req-4: Commands Browser
The Settings page includes a Commands Browser section that fetches `GET /commands` from each connected agent and displays commands grouped by source: global (`~/.claude/commands/`) vs project-level (`.claude/commands/` relative to the project). Commands are read-only in this version.

## Scope
- **IN**: `NEXUS_PROJECTS_DIR` env var support in agent, `/projects/discovered` endpoint, `/session/start` endpoint, `/agent/self` endpoint, ProjectCard Start Session button with optimistic UI, agent CRUD in Settings (add/remove/view frontmatter), commands browser with global vs project-level grouping
- **OUT**: Writing agent config back to remote `agents.toml` via API, command editing or toggling, project subdirectory recursion, session routing across multiple agents for a single start request

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
| `projects_dir` has thousands of entries | Scan immediate children only, no recursion; cap response at 200 dirs |
| `dashboard.json` diverges from `NEXUS_AGENTS` | Dashboard merges both; `NEXUS_AGENTS` takes precedence on name collision |
| Start Session called while tmux session name collides | Use `<project>-<timestamp>` as session name to avoid conflicts |
