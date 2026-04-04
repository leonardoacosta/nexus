# Implementation Tasks

<!-- beads:epic:nx-q3q -->

## Agent Batch

- [ ] [1.1] [P-1] Read `NEXUS_PROJECTS_DIR` env var (default `~/dev`) at startup, store in `AppState.projects_dir` [owner:api-engineer] [beads:nx-3xz]
- [ ] [1.2] [P-1] Add `GET /projects/discovered` handler — scan `projects_dir` immediate children, merge with `SessionRegistry` active counts, return `Vec<DiscoveredProject>` JSON, cap at 200 [owner:api-engineer] [beads:nx-25n]
- [ ] [1.3] [P-1] Add `POST /session/start` handler — validate tmux available + path exists, run `tmux new-window -d -c <path> -n <project>-<ts>` + send-keys `claude`, return `{ session_name, started }` [owner:api-engineer] [beads:nx-cg3]
- [ ] [1.4] [P-1] Add `GET /agent/self` handler — return `{ name, host, port, role, projects_dir }` from `AppState` [owner:api-engineer] [beads:nx-gem]
- [ ] [1.5] [P-2] Register new routes in `http_handlers/mod.rs` and wire into axum router in `main.rs` [owner:api-engineer] [beads:nx-2ur]
- [ ] [1.6] [P-2] Add `Environment=NEXUS_PROJECTS_DIR=%h/dev` to `deploy/nexus-agent.service` [owner:api-engineer] [beads:nx-5vo]

## Core Batch

- [ ] [2.1] [P-1] Add `DiscoveredProject` interface to `packages/core/src/types/project.ts` with fields `name`, `path`, `active_sessions`, `total_sessions`, `agent` [owner:types-engineer] [beads:nx-31d]
- [ ] [2.2] [P-1] Add optional `projects_dir: z.string().optional()` to `AgentConfigSchema` in `packages/core/src/config.ts` [owner:types-engineer] [beads:nx-q29]
- [ ] [2.3] [P-1] Export `DiscoveredProject` from `packages/core/src/index.ts` [owner:types-engineer] [beads:nx-215]
- [ ] [2.4] [P-2] Add `fetchDiscoveredProjects(agent)` method to `AgentClient` in `agent-client.ts` — calls `GET /projects/discovered`, tags each entry with `agent` name [owner:api-engineer] [beads:nx-18s]
- [ ] [2.5] [P-2] Add `startSession(agent, body)` method to `AgentClient` — calls `POST /session/start` [owner:api-engineer] [beads:nx-02u]
- [ ] [2.6] [P-2] Add `fetchAgentSelf(agent)` method to `AgentClient` — calls `GET /agent/self` [owner:api-engineer] [beads:nx-dju]
- [ ] [2.7] [P-2] Add `fetchAgentCommands(agent)` method to `AgentClient` — calls `GET /commands` [owner:api-engineer] [beads:nx-gnd]
- [ ] [2.8] [P-2] Update `get-client.ts` to merge `~/.config/nexus/dashboard.json` with `NEXUS_AGENTS` (NEXUS_AGENTS takes precedence on name collision) [owner:api-engineer] [beads:nx-ypwq]
- [ ] [2.9] [P-2] Update `app/actions/projects.ts` `fetchProjects()` to call `fetchDiscoveredProjects()` across all agents [owner:api-engineer] [beads:nx-bzmd]
- [ ] [2.10] [P-2] Add `startSession()` and `fetchAgentConfigs()` server actions to `app/actions/settings.ts` [owner:api-engineer] [beads:nx-uk2o]
- [ ] [2.11] [P-2] Add `saveAgentConfig()` server action that writes/updates `~/.config/nexus/dashboard.json` [owner:api-engineer] [beads:nx-f6vd]

## UI Batch

- [ ] [3.1] [P-1] Update `ProjectsPoller` to accept and render `WithAgent<DiscoveredProject>[]`, update prop types [owner:ui-engineer] [beads:nx-v70z]
- [ ] [3.2] [P-1] Update `ProjectCard` to accept `DiscoveredProject` — add "Start Session" button with optimistic `starting` state, show inline error if action fails [owner:ui-engineer] [beads:nx-y56o]
- [ ] [3.3] [P-1] Create `AgentManagementPanel` component — list agents with frontmatter table, Add Agent form (name/host/port/projects_dir), Remove button per agent [owner:ui-engineer] [beads:nx-elcg]
- [ ] [3.4] [P-1] Create `CommandsBrowserPanel` component — fetch commands from all online agents, group by Global vs Project source, show name/description/tier/cost badges [owner:ui-engineer] [beads:nx-c913]
- [ ] [3.5] [P-2] Integrate `AgentManagementPanel` and `CommandsBrowserPanel` into Settings page layout [owner:ui-engineer] [beads:nx-yvtp]
- [ ] [3.6] [P-2] Update `ProjectsPage` server component to pass `initialProjects` from updated `fetchProjects()` [owner:ui-engineer] [beads:nx-sca5]

## E2E Batch

- [ ] [4.1] Add acceptance test `ac-15-projects-discovered.test.tsx` — projects page shows dirs when no sessions are active [owner:e2e-engineer] [beads:nx-d7a8]
- [ ] [4.2] Add acceptance test `ac-16-start-session.test.tsx` — Start Session button shows optimistic state [owner:e2e-engineer] [beads:nx-kxcx]
- [ ] [4.3] Add acceptance test `ac-17-agent-management.test.tsx` — Settings agent CRUD panel renders agents list and handles add form [owner:e2e-engineer] [beads:nx-w66q]
