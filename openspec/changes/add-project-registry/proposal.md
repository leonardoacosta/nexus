# Proposal: Add Project Registry

## Change ID
`add-project-registry`

## Summary
Add a canonical project registry to the database so Nexus knows which projects exist and where they live on each machine (homelab = primary, mac = backup). Projects are auto-discovered from filesystem scans and surfaced in the dashboard with per-machine location badges and primary-agent-aware session routing.

## Context
- Extends: `packages/db/src/schema/` (new tables), `packages/core/src/types/project.ts` (new types), `apps/agent/src/routes/projects-discovered.ts` (upsert after scan), `apps/nextjs/src/app/projects/` (UI)
- Related: `project-dir-scan` spec (filesystem scan — no DB persistence, this builds on it), `fix-project-discovery` (must complete first — stabilizes `DiscoveredProject` type and dedup logic)
- Depends on: `fix-project-discovery` change completing before apply

## Motivation
Projects currently exist only in memory — each agent scans its `projectsDir` and the Next.js client deduplicates by path in a TTL cache. This means:
- No canonical project list survives a restart or cache eviction
- No knowledge of which machine a project lives on (homelab vs mac)
- No "primary" machine concept — session routing is first-come, first-served
- The dashboard shows per-agent project cards with no grouping by canonical name

With a project registry, Nexus gains a persistent, queryable source of truth: projects grouped by name, each with a list of locations across agents, and intelligent routing that prefers homelab (primary) and falls back to mac when homelab is offline.

## Requirements

### Req-1: DB Schema — projects + project_locations tables

Add two new Drizzle/PostgreSQL tables:
- `projects`: canonical project identity (id, name, primary_agent_id, status)
- `project_locations`: per-machine presence (project_id × agent_id × path, with priority and session counts)

First agent to discover a project becomes `primary_agent_id`. Priority 1 = primary; 999 = others.
`project_locations.status` tracks 'active' | 'missing' | 'archived'.

### Req-2: Agent Discovery Upsert

After each successful filesystem scan in `GET /projects/discovered`, the agent SHALL upsert each discovered project into `projects` + `project_locations` using the expanded (absolute) path. Subsequent scans update session counts and `last_discovered_at`. Projects not found in the current scan have their location marked 'missing' (not deleted).

### Req-3: Canonical Projects API

Add `GET /api/projects` Next.js route that JOINs `projects` + `project_locations` + session counts from `sessions` table. Update `fetchProjects()` server action to use this endpoint. Response returns `CanonicalProject[]` ordered by active sessions DESC, then name ASC.

### Req-4: Projects UI — Location Badges + Primary Routing

Update the projects dashboard to:
- Group cards by canonical project name (one card per project, not per agent)
- Show location badges: `homelab ●` (primary, active) / `mac ○` (backup, active) / `mac (missing)` (location not found in last scan)
- Route "Start Session" to `primary_agent_id`; if primary offline, auto-fallback to next active location with a toast: "Connected to mac (homelab offline)"

## Scope
- **IN**: DB schema (projects + project_locations), agent upsert after scan, canonical API endpoint, UI grouping + location badges + primary routing
- **OUT**: Manual project registration UI (user explicitly adds a path), per-agent `projectsDir` editing from UI, project archival UI, multi-depth scan changes (covered by `project-dir-scan` spec)

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/` | Add `projects.ts` + `projectLocations.ts` |
| `packages/core/src/types/project.ts` | Add `CanonicalProject`, `ProjectLocation` interfaces |
| `apps/agent/src/routes/projects-discovered.ts` | Upsert after scan |
| `apps/nextjs/src/app/api/projects/route.ts` | New GET handler (canonical JOIN) |
| `apps/nextjs/src/app/actions/projects.ts` | Update to use canonical API |
| `apps/nextjs/src/components/ProjectCard.tsx` | Location badges |
| `apps/nextjs/src/components/ProjectsPoller.tsx` | Group by canonical name |

## Risks
| Risk | Mitigation |
|------|-----------|
| `fix-project-discovery` still in flight — type changes may conflict | Gate: do not apply until `fix-project-discovery` is closed |
| Agent upsert on every scan may slow `/projects/discovered` response | Upsert is a single UPSERT per project (ON CONFLICT DO UPDATE); batched, not per-row round trips |
| Primary agent set incorrectly if mac discovers first | Homelab agent always on + discovers at startup; acceptable edge case for now |
| `project_locations` grows unbounded if many agents churn | Soft-delete via 'missing' status; prune locations not seen in 7 days (future) |
