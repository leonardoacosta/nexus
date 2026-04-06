# project-registry Specification

## Purpose
Canonical project registry — persistent, queryable source of truth for project identity and per-machine location across Nexus agents.

## ADDED Requirements

### Requirement: project-registry-schema
`packages/db/src/schema/projects.ts` MUST define a `projects` table with columns: `id` (UUID PK, gen_random_uuid()), `name` (text, NOT NULL, UNIQUE), `primary_agent_id` (text, NOT NULL, FK → agents.id), `description` (text, nullable), `tags` (text[], nullable), `status` (text, default 'active'), `discoveredAt` (timestamp, defaultNow()), `updatedAt` (timestamp, defaultNow()).

`packages/db/src/schema/projectLocations.ts` MUST define a `project_locations` table with columns: `id` (UUID PK), `projectId` (FK → projects.id, CASCADE DELETE), `agentId` (FK → agents.id, CASCADE DELETE), `path` (text, NOT NULL), `status` (text, default 'active'), `activeSessions` (integer, default 0), `totalSessions` (integer, default 0), `lastDiscoveredAt` (timestamp, nullable), `priority` (integer, default 999). UNIQUE constraint on (`project_id`, `agent_id`).

Both tables MUST be exported from `packages/db/src/schema/index.ts`.

#### Scenario: projects table accepts first discovery insert
Given a new project "nx" discovered by agent "homelab" at path "/home/user/dev/nx"
When an INSERT is executed with `primary_agent_id = 'homelab'`, `name = 'nx'`, `status = 'active'`
Then the row is created with a generated UUID and `discovered_at = NOW()`

#### Scenario: project name uniqueness enforced
Given a row already exists with `name = 'nx'`
When a second INSERT with `name = 'nx'` is attempted
Then a unique constraint violation is raised

#### Scenario: project_locations uniqueness per agent
Given location row (project_id=X, agent_id='homelab') exists
When a second INSERT with the same (project_id, agent_id) is attempted
Then ON CONFLICT DO UPDATE fires (upsert), not a duplicate row

#### Scenario: cascade delete propagates
Given project row with id=X has two location rows (homelab + mac)
When the project row is deleted
Then both location rows are deleted automatically

### Requirement: discovery-upsert
`apps/agent/src/routes/projects-discovered.ts` MUST, after each successful filesystem scan, upsert each discovered project into `projects` (ON CONFLICT ON name DO NOTHING for primary_agent_id — first writer wins) and upsert into `project_locations` (ON CONFLICT ON (project_id, agent_id) DO UPDATE SET path, status='active', active_sessions, total_sessions, last_discovered_at=NOW()). Projects NOT returned by the current scan MUST have their location's status set to 'missing' for this agent. Path stored MUST be the expanded absolute path (via `expandProjectsDir`).

#### Scenario: first discovery creates canonical record
Given agent "homelab" scans and finds "nx" at "/home/leo/dev/nx"
When the upsert runs
Then `projects` has one row with `name='nx'`, `primary_agent_id='homelab'`
And `project_locations` has one row with `agent_id='homelab'`, `path='/home/leo/dev/nx'`, `status='active'`, `priority=1`

#### Scenario: second agent adds location without overwriting primary
Given "nx" already exists with `primary_agent_id='homelab'`
When agent "mac" upserts with its path "/Users/leo/dev/nx"
Then `projects.primary_agent_id` remains 'homelab'
And `project_locations` gains a second row with `agent_id='mac'`, `priority=999`

#### Scenario: missing project marks location stale
Given "nx" was previously discovered by homelab
When homelab scans and "nx" is NOT in the result (deleted or moved)
Then `project_locations` row for (nx, homelab) has `status='missing'`
And the `projects` row is NOT deleted

#### Scenario: tilde paths expanded before storage
Given `projectsDir = "~/dev"` and project is at `~/dev/nx`
When the upsert runs
Then `project_locations.path` is `/home/leo/dev/nx` (absolute, no tilde)

### Requirement: canonical-projects-api
`apps/nextjs/src/app/api/projects/route.ts` MUST implement `GET /api/projects` returning `CanonicalProject[]`. Each entry JOINs `projects` + `project_locations` + aggregated session counts from the `sessions` table (active = last 5 min, total = 24h window). Response ordered by `active_sessions DESC`, then `name ASC`.

`packages/core/src/types/project.ts` MUST export `CanonicalProject` and `ProjectLocation` interfaces:
```
CanonicalProject { id, name, primaryAgentId, locations: ProjectLocation[], activeSessions, totalSessions }
ProjectLocation { agentId, agentName, path, activeSessions, totalSessions, isPrimary, status, priority }
```

`apps/nextjs/src/app/actions/projects.ts` `fetchProjects()` MUST be updated to call `GET /api/projects` and return `CanonicalProject[]`.

#### Scenario: canonical list with two locations
Given "nx" exists in projects table with homelab (primary) and mac locations, 3 active sessions on homelab
When GET /api/projects is called
Then response includes { name: "nx", primaryAgentId: "homelab", activeSessions: 3, locations: [{ agentId: "homelab", isPrimary: true }, { agentId: "mac", isPrimary: false }] }

#### Scenario: missing location included with status
Given "nx" has homelab location (active) and mac location (missing)
When GET /api/projects is called
Then "nx" has two locations; mac location has `status: "missing"`

#### Scenario: result ordering
Given "oo" has 2 active sessions, "nx" has 5, "tc" has 0
When GET /api/projects is called
Then order is nx (5), oo (2), tc (0)

#### Scenario: empty registry returns empty array
Given projects table is empty
When GET /api/projects is called
Then response is `[]` with HTTP 200

### Requirement: projects-ui-locations
`apps/nextjs/src/components/ProjectsPoller.tsx` MUST group projects by canonical name (one card per `CanonicalProject.id`). `apps/nextjs/src/components/ProjectCard.tsx` MUST render location badges for each location: filled dot (●) for 'active' primary, open dot (○) for 'active' non-primary, strikethrough label for 'missing' locations. The "Start Session" action MUST route to `primaryAgentId` if that location is 'active'; if primary is 'missing' or offline, route to the first 'active' location and show a toast: "Connected to <agent> (homelab offline)".

#### Scenario: primary active — route to homelab
Given "nx" primaryAgentId="homelab" and homelab location is 'active'
When user clicks "Start Session"
Then session is started on homelab agent

#### Scenario: primary missing — fallback to mac with toast
Given "nx" primaryAgentId="homelab" and homelab location is 'missing', mac location is 'active'
When user clicks "Start Session"
Then session is started on mac
And toast appears: "Connected to mac (homelab offline)"

#### Scenario: location badges render correctly
Given "nx" has homelab (primary, active) + mac (active)
When ProjectCard renders
Then homelab badge shows "homelab ●" and mac badge shows "mac ○"

#### Scenario: missing location shown as degraded
Given "nx" has homelab (active) + mac (missing)
When ProjectCard renders
Then mac badge shows with 'missing' visual treatment (strikethrough or dim)
