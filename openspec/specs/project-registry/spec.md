# project-registry Specification

## Purpose
TBD - created by archiving change add-project-registry. Update Purpose after archive.
## Requirements
### Requirement: project-registry-schema
`packages/db/src/schema/projects.ts` MUST define a `projects` table with columns: `id` (UUID PK, gen_random_uuid()), `name` (text, NOT NULL), `primary_agent_id` (text, NOT NULL, FK → agents.id), `git_remote_url` (text, nullable), `description` (text, nullable), `tags` (text[], nullable), `status` (text, default 'active'), `discoveredAt` (timestamp, NOT NULL, defaultNow()), `updatedAt` (timestamp, defaultNow()). The table MUST have a composite UNIQUE constraint on `(name, git_remote_url)`. The previously plain `UNIQUE(name)` constraint MUST be removed.

`packages/db/src/schema/projectLocations.ts` MUST define a `project_locations` table with columns: `id` (UUID PK), `projectId` (FK → projects.id, CASCADE DELETE), `agentId` (FK → agents.id, CASCADE DELETE), `path` (text, NOT NULL), `gitRemoteUrl` (text, nullable), `status` (text, default 'active'), `activeSessions` (integer, default 0), `totalSessions` (integer, default 0), `lastDiscoveredAt` (timestamp, nullable), `priority` (integer, default 999). UNIQUE constraint on (`project_id`, `agent_id`).

Both tables MUST be exported from `packages/db/src/schema/index.ts`.

#### Scenario: projects table enforces composite unique on (name, git_remote_url)
- **WHEN** a row with `name='nx'` and `git_remote_url='git@github.com:owner/nx.git'` exists
- **AND** a second INSERT with the same `name` and `git_remote_url` is attempted
- **THEN** a unique constraint violation is raised

#### Scenario: two local-only projects with same name coexist
- **WHEN** a row with `name='api'` and `git_remote_url=NULL` exists
- **AND** a second INSERT with `name='api'` and `git_remote_url=NULL` is attempted
- **THEN** the insert succeeds (PostgreSQL treats NULL as distinct in unique indexes)

#### Scenario: discoveredAt is never null after insert
- **WHEN** a new project row is inserted without specifying `discoveredAt`
- **THEN** the column value is set by `defaultNow()` and is non-null

#### Scenario: cascade delete propagates
- **WHEN** project row with id=X has two location rows (homelab + mac)
- **AND** the project row is deleted
- **THEN** both location rows are deleted automatically

### Requirement: discovery-upsert
`apps/agent/src/routes/projects-discovered.ts` MUST, on each cache-miss compute cycle, initialize a fresh `seenCanonicalPaths` Set at the start of the scan (not re-created per HTTP request, but reset at the top of each scan block). After each successful filesystem scan, the handler MUST `await upsertProjectLocations(db, agentId, toUpsert)` before sending the HTTP response; fire-and-forget is not permitted. Each discovered project MUST be upserted with its `gitRemoteUrl` value (null if unavailable). Projects NOT returned by the current scan MUST have their location's status set to 'missing' for this agent. Path stored MUST be the expanded absolute path (via `expandProjectsDir`), which MUST start with `/home/` or `/Users/` after expansion; paths outside these prefixes MUST be rejected with `400`.

`apps/agent/src/db/project-registry.ts:upsertProjectLocations` MUST retry the `select` on `projects` once if the first result is empty after `INSERT … ON CONFLICT DO NOTHING`; if both attempts return empty, the location upsert is skipped with a `warn` log. The `ProjectToUpsert` interface MUST include a `gitRemoteUrl: string | null` field, and the upsert MUST write this value to `project_locations.git_remote_url`.

#### Scenario: dedup set resets each compute cycle, not each HTTP request
- **WHEN** two HTTP requests hit the handler within the 5 s TTL window
- **THEN** the second request is served from cache; the dedup set is not re-initialized

#### Scenario: dedup set prevents symlink duplicate within one scan
- **WHEN** `~/dev/link` is a symlink pointing to `~/dev/nx` and both are in the scan
- **AND** a cache-miss triggers a fresh scan
- **THEN** only one entry is added for the canonical path; only one location row is upserted

#### Scenario: upsert is awaited before response
- **WHEN** a cache-miss scan completes with 3 projects
- **THEN** all 3 location rows are written to the DB before the HTTP 200 response is returned

#### Scenario: select retry on race condition
- **WHEN** `INSERT INTO projects … ON CONFLICT DO NOTHING` fires (another agent won)
- **AND** the immediate `SELECT` returns empty (brief replication delay)
- **THEN** a second `SELECT` is issued; if it returns the row, the location upsert proceeds

#### Scenario: path outside allowed prefix rejected
- **WHEN** `projectsDir` resolves to `/opt/projects` (not under `/home/` or `/Users/`)
- **THEN** the handler returns `400` with a descriptive error message

#### Scenario: git_remote_url stored per location
- **WHEN** agent "homelab" discovers "nx" at `/home/leo/dev/nx` with remote `git@github.com:owner/nx.git`
- **AND** the upsert runs
- **THEN** `project_locations` row for (nx, homelab) has `git_remote_url = 'git@github.com:owner/nx.git'`

### Requirement: canonical-projects-api
`apps/nextjs/src/app/actions/projects.ts` `fetchProjects()` MUST return `CanonicalProject[]` where `discoveredAt` is non-nullable (`string`, not `string | null`). The `null` fallback `?? new Date().toISOString()` MUST be removed; if a DB row returns null for `discovered_at`, it MUST be treated as a data error (log warn, omit the project). `fetchProject(name)` MUST apply the same non-nullable rule.

The `projects/[name]/page.tsx` session filter MUST be `s.project === projectName` only; the `s.project === null && projectName === "Unassigned"` branch MUST be removed.

`packages/core/src/types/project.ts` `CanonicalProject.discoveredAt` MUST be typed as `string` (not `string | null` or `string | undefined`).

#### Scenario: discoveredAt is stable across fetches
- **WHEN** `fetchProjects()` is called twice for the same project
- **THEN** `discoveredAt` returns the same value both times (no new Date() re-generation)

#### Scenario: Unassigned detail page shows registry not found
- **WHEN** no project named "Unassigned" exists in the DB
- **AND** `/projects/Unassigned` is loaded
- **THEN** the page renders "Project not found in registry" (null returned from fetchProject)
- **AND** session filter is `s.project === "Unassigned"` (no null-project shortcut)

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

### Requirement: stale-location-cleanup
`apps/agent/src/db/project-registry.ts` MUST export `cleanupStaleProjectLocations(db: Db): Promise<{ deletedLocations: number; archivedProjects: number }>`. This function MUST:
1. DELETE rows from `project_locations` where `status = 'missing'` AND `last_discovered_at < NOW() - INTERVAL '30 days'`.
2. UPDATE `projects` SET `status = 'archived'` WHERE `id` has no remaining `project_locations` rows with `status IN ('active', 'missing')`.

The Bun agent startup MUST call `cleanupStaleProjectLocations` once at boot and then on a 24-hour interval.

#### Scenario: locations missing for more than 30 days are deleted
- **WHEN** a `project_locations` row has `status='missing'` and `last_discovered_at = NOW() - 31 days`
- **AND** `cleanupStaleProjectLocations` runs
- **THEN** that row is deleted from `project_locations`

#### Scenario: locations missing for less than 30 days are retained
- **WHEN** a `project_locations` row has `status='missing'` and `last_discovered_at = NOW() - 29 days`
- **AND** `cleanupStaleProjectLocations` runs
- **THEN** that row is NOT deleted

#### Scenario: project with no remaining locations is archived
- **WHEN** all `project_locations` rows for project X are deleted by the cleanup
- **AND** `cleanupStaleProjectLocations` runs
- **THEN** `projects.status` for X is set to `'archived'`

#### Scenario: cleanup returns counts
- **WHEN** `cleanupStaleProjectLocations` deletes 3 locations and archives 1 project
- **THEN** the return value is `{ deletedLocations: 3, archivedProjects: 1 }`

### Requirement: projects-tag-group-counts
`apps/nextjs/src/app/actions/projects.ts` MUST export `fetchProjectTagGroups(): Promise<TagGroupCount[]>`. `TagGroupCount` MUST be defined in `packages/core/src/types/project.ts` as `{ tag: string; activeSessions: number; totalSessions: number; projectCount: number }`. The aggregation MUST sum `activeSessions` and `totalSessions` across all `CanonicalProject` entries that include the given tag, and count distinct projects per tag. The `/projects` page table header MUST consume this data to display per-tag session rollups.

#### Scenario: tag group counts aggregate correctly
- **WHEN** projects "nx" (tags: ["work"], activeSessions: 2) and "oo" (tags: ["work", "client"], activeSessions: 1) exist
- **AND** `fetchProjectTagGroups()` is called
- **THEN** tag "work" returns `{ activeSessions: 3, totalSessions: ..., projectCount: 2 }`
- **AND** tag "client" returns `{ activeSessions: 1, totalSessions: ..., projectCount: 1 }`

#### Scenario: project with no tags is excluded from all groups
- **WHEN** a project has `tags = null` or `tags = []`
- **THEN** it does not contribute to any `TagGroupCount` entry

### Requirement: project-detail-agent-badges
`apps/nextjs/src/components/ProjectSettingsPanel.tsx` (or a sibling component rendered on the detail page) MUST render one badge per `CanonicalProject.locations` entry. Each badge MUST show: agent name, status dot (● for active, ○ for missing), and a tooltip with the full path. The badge component logic MUST be shared with or delegate to the existing `ProjectCard` location badge rendering.

#### Scenario: active primary location shows filled dot
- **WHEN** `canonicalProject.locations` includes `{ agentId: "homelab", status: "active", isPrimary: true }`
- **THEN** the detail page renders a badge labeled "homelab ●"

#### Scenario: missing location shows open dot
- **WHEN** `canonicalProject.locations` includes `{ agentId: "mac", status: "missing" }`
- **THEN** the detail page renders a badge labeled "mac ○"

#### Scenario: path shown on hover
- **WHEN** user hovers over the agent badge
- **THEN** the full path (e.g. `/home/leo/dev/nx`) is shown in a tooltip

### Requirement: Agent identity resolves via configured agent ID, not hostname
The agent's identity SHALL resolve to the `agentId` configured in `agents.toml` (via `packages/core/src/config.ts` loader), NOT via `os.hostname()`. When no agent ID is configured, the resolver MAY fall back to `os.hostname()` to preserve backward compatibility on single-machine deploys.

#### Scenario: Configured agent ID is used for project-discovered lookup
- **GIVEN** `agents.toml` has an entry with `id = "my-agent"` for the current agent
- **AND** `os.hostname()` returns `"pod-xyz-789"` (container hostname, unrelated to agent ID)
- **WHEN** `/projects/discovered` queries the agent via its configured identity
- **THEN** the lookup SHALL use `"my-agent"`, not `"pod-xyz-789"`
- **AND** the lookup SHALL succeed

#### Scenario: Fallback to hostname when no agent ID is configured
- **GIVEN** `agents.toml` has no `id` field (or no agent entry matches)
- **WHEN** the identity is resolved
- **THEN** `os.hostname()` MAY be used as a fallback
- **AND** a warning SHALL be logged noting the fallback was taken

### Requirement: Cursor pagination on project endpoints
`GET /projects` and `GET /projects/discovered` SHALL accept optional `cursor` (opaque string token) and `limit` (integer, default 50, max 200) query parameters. Responses SHALL include `nextCursor` when more results exist beyond the returned page. The current `truncated: true` behavior on `/projects/discovered` SHALL be preserved as a fallback for callers that do not supply a cursor.

#### Scenario: Paginated request returns windowed results with nextCursor
- **GIVEN** a registry with 120 projects
- **WHEN** a client calls `GET /projects?limit=50`
- **THEN** the response SHALL contain 50 project entries
- **AND** the response SHALL include `nextCursor` set to an opaque string
- **AND** calling `GET /projects?cursor=<nextCursor>&limit=50` SHALL return the next 50 entries
- **AND** the third page SHALL contain the remaining 20 entries with `nextCursor: null` or absent

#### Scenario: Non-paginated caller gets legacy truncated-flag behavior
- **GIVEN** `/projects/discovered` would return more than 100 project locations
- **WHEN** a client calls `GET /projects/discovered` without `cursor` or `limit` query params
- **THEN** the response SHALL return at most 100 entries with `truncated: true` (existing behavior)
- **AND** no `nextCursor` SHALL be included

#### Scenario: Invalid cursor returns 400
- **GIVEN** a client calls `GET /projects?cursor=not-a-valid-cursor`
- **WHEN** the cursor fails to decode
- **THEN** the response SHALL be 400 Bad Request with a clear error message
- **AND** the response SHALL NOT leak the internal cursor format

#### Scenario: limit exceeding max clamps to max
- **GIVEN** a client calls `GET /projects?limit=1000`
- **WHEN** the server processes the request
- **THEN** the response SHALL contain at most 200 entries (max limit enforced server-side)
- **AND** a warning SHALL be logged noting the clamp was applied

### Requirement: Folder-based project auto-discovery

The agent MUST scan configured dev-roots for directories containing `.git` OR
`openspec/`, at startup and on a periodic interval, and persist discovered
projects via `db/project-registry`. Discovery MUST NOT require manual
registration or a hand-maintained `projects.json`.

#### Scenario: discovers a repo on the agent host

- **GIVEN** a dev-root containing a directory with `.git` and `openspec/`
- **WHEN** the agent starts (or the periodic scan runs)
- **THEN** that project appears in `db/project-registry`
- **AND** it is not gated behind a static `projects.json`

### Requirement: spec-watcher consumes the project registry

spec-watcher MUST enumerate the projects it polls from the auto-discovered
`db/project-registry`, so `/specs` reflects openspec changes present on the
agent host.

#### Scenario: specs surface for a discovered repo

- **GIVEN** a discovered project with `openspec/changes/<slug>/`
- **WHEN** spec-watcher polls
- **THEN** `GET /specs` includes that change (no longer `[]`)

### Requirement: /projects aggregates registry and excludes hidden

`GET /projects` MUST aggregate the discovered registry and MUST omit any
project whose `hidden` flag is set.

#### Scenario: hidden project omitted

- **GIVEN** a discovered project flagged hidden
- **WHEN** the dashboard requests `GET /projects`
- **THEN** that project is not in the response

### Requirement: Removable project reference persists across rescans

A project MUST be removable via a persisted `hidden` flag set through `PATCH
/projects/:id`. The auto-discovery scanner MUST treat the hidden flag as
sticky — re-scanning a hidden project's folder MUST NOT clear `hidden`.

#### Scenario: hide survives a rescan

- **GIVEN** a discovered project the user has hidden
- **WHEN** the periodic scanner runs again over its folder
- **THEN** the project remains hidden and absent from `GET /projects`

#### Scenario: dashboard can remove a project

- **WHEN** the user removes a project in the dashboard ProjectsView
- **THEN** a `PATCH /projects/:id` sets `hidden`
- **AND** the project disappears from the list and stays gone

