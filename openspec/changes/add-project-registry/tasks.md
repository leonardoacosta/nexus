# Implementation Tasks

<!-- beads:epic:nx-0p7b -->

## DB Batch

- [ ] [1.1] [P-1] Add `projects` table schema in `packages/db/src/schema/projects.ts` (id UUID PK, name UNIQUE, primary_agent_id FK agents.id, description, tags[], status, discoveredAt, updatedAt) [owner:db-engineer] [beads:nx-0zdw]
- [ ] [1.2] [P-1] Add `project_locations` table schema in `packages/db/src/schema/projectLocations.ts` (id UUID PK, projectId FK, agentId FK, path, status, activeSessions, totalSessions, lastDiscoveredAt, priority, UNIQUE(projectId, agentId)) [owner:db-engineer] [beads:nx-m0fn]
- [ ] [1.3] [P-2] Export `projects` and `projectLocations` tables from `packages/db/src/schema/index.ts` [owner:db-engineer] [beads:nx-okg7]
- [ ] [1.4] [P-2] Add `CanonicalProject` and `ProjectLocation` interfaces to `packages/core/src/types/project.ts` [owner:types-engineer] [beads:nx-sebs]
- [ ] [1.5] [P-3] Generate and apply DB migration (`pnpm db:generate && pnpm db:migrate`) [owner:db-engineer] [beads:nx-fvm1]

## API Batch

- [ ] [2.1] [P-1] Add `upsertProjectLocation(db, agentId, projects)` helper in `apps/agent/src/db/project-registry.ts` (batch upsert: ON CONFLICT DO NOTHING for projects, ON CONFLICT DO UPDATE for locations, sweep missing) [owner:api-engineer] [beads:nx-cqh2]
- [ ] [2.2] [P-2] Call `upsertProjectLocation` in `apps/agent/src/routes/projects-discovered.ts` after each successful scan, passing expanded absolute paths [owner:api-engineer] [beads:nx-8cqk]
- [ ] [2.3] [P-1] Add `GET /api/projects` route at `apps/nextjs/src/app/api/projects/route.ts` (JOIN projects + project_locations + session counts, ordered by active_sessions DESC then name ASC) [owner:api-engineer] [beads:nx-o8bo]
- [ ] [2.4] [P-2] Update `fetchProjects()` in `apps/nextjs/src/app/actions/projects.ts` to call `GET /api/projects` and return `CanonicalProject[]` [owner:api-engineer] [beads:nx-r507]
- [ ] [2.5] [P-2] Add `resolveAttachAgent(project, agentStatuses)` helper in `apps/nextjs/src/lib/agent-routing.ts` (prefer primaryAgentId if online + active, fallback to first available location) [owner:api-engineer] [beads:nx-bwgb]

## UI Batch

- [ ] [3.1] [P-1] Update `ProjectsPoller` to consume `CanonicalProject[]` (group by canonical id, not per-agent; remove `WithAgent<DiscoveredProject>` dep) [owner:ui-engineer] [beads:nx-ahju]
- [ ] [3.2] [P-1] Add location badges to `ProjectCard` (homelab ● for primary-active, mac ○ for non-primary-active, dim/strikethrough for missing) [owner:ui-engineer] [beads:nx-ohe9]
- [ ] [3.3] [P-2] Wire "Start Session" button through `resolveAttachAgent`; show toast "Connected to <agent> (homelab offline)" when falling back [owner:ui-engineer] [beads:nx-scrk]

## E2E Batch

- [ ] [4.1] Test agent upsert: scan produces correct rows in `projects` + `project_locations`; second agent adds location without overwriting primary [owner:e2e-engineer] [beads:nx-mb31]
- [ ] [4.2] Test canonical API: `GET /api/projects` returns merged locations + session counts in correct order [owner:e2e-engineer] [beads:nx-ltwd]
- [ ] [4.3] Test session routing: primary online → routes to homelab; primary missing → routes to mac with fallback toast [owner:e2e-engineer] [beads:nx-1c5y]
