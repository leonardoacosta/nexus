# Proposal: Agent Registry — DB-Backed

## Change ID
`agent-registry-db`

## Summary
Replace the file-based `~/.config/nexus/dashboard.json` agent registry with a PostgreSQL `agents`
table, implement the two missing agent endpoints (`/agent/self`, `/projects/discovered`), and
eliminate the ghost `NEXUS_PROJECTS_DIR` env var by storing `projects_dir` in the DB.

## Context
- Extends: `packages/db/src/schema/` (new table), `apps/agent/src/server.ts` (two new routes),
  `apps/nextjs/src/lib/get-client.ts` (DB read), `apps/nextjs/src/app/actions/settings.ts` (DB write)
- Related: `openspec/specs/agent-management` (4 existing requirements), `openspec/archive/2026-04/add-settings-page`
- Replaces: `~/.config/nexus/dashboard.json` file I/O, `agents.toml` deploy references

## Motivation
Three problems converge here:

1. **Ghost env var**: `NEXUS_PROJECTS_DIR=%h/dev` was set in the systemd service file but the Bun
   agent never reads it — dead wiring. The `/projects/discovered` endpoint the dashboard calls
   returns 404 because it was never implemented.

2. **File-based agent registry**: `dashboard.json` requires manual file management, a `resetClient()`
   singleton workaround after mutations, and breaks across `force-dynamic` Next.js renders (the
   bug found during webapp-testing). Moving to DB gives fresh reads per-request.

3. **Unimplemented API surface**: `AgentClient.fetchAgentSelf()` and `fetchDiscoveredProjects()` in
   `apps/nextjs/src/lib/agent-client.ts` call `/agent/self` and `/projects/discovered` — both
   return 404. The settings page shows stale/broken agent config data as a result.

The fix: one `agents` table centralises the registry; agents self-register on startup (upsert by
hostname); the dashboard reads and writes the same table.

## Requirements

### Req-1: agents DB table
An `agents` table in PostgreSQL stores the registered agent fleet. Each row represents one
`nexus-agent` instance with its connectivity details and filesystem config.

### Req-2: Agent self-registration
On startup, each agent upserts its own row in the `agents` table (keyed by hostname). The row
records `host`, `port`, `projects_dir` (read from env `NEXUS_PROJECTS_DIR` as the bootstrap
value, defaulting to `$HOME/dev`). After the initial upsert, `projects_dir` is DB-authoritative
and editable via the settings page.

### Req-3: /agent/self endpoint
`GET /agent/self` returns the agent's own DB row (name, host, port, projects_dir, enabled).
Used by the dashboard settings page to display per-agent config.

### Req-4: /projects/discovered endpoint
`GET /projects/discovered` walks `projects_dir` (from the agent's DB row), identifies git
repositories (presence of `.git`), cross-references with recent sessions, and returns
`DiscoveredProjectsResponse`. Truncates at 100 results.

### Req-5: Dashboard reads agents from DB
`apps/nextjs/src/lib/get-client.ts` queries the `agents` table instead of reading
`dashboard.json`. Fallback: if DB has no rows, behave as before (localhost:7400 default).

### Req-6: Settings page CRUD via DB
`saveAgentConfig()` writes to the `agents` table. `fetchAgentConfigs()` reads from it.
`dashboard.json` file I/O and `resetClient()` are removed.

### Req-7: NEXUS_PROJECTS_DIR ghost removal
Remove `NEXUS_PROJECTS_DIR` from `deploy/nexus-agent.service`. Remove `agents.toml` seeding
from `deploy/install.sh`. The env var is replaced by the DB column for runtime config; initial
bootstrap uses `$HOME/dev` as the default in the self-registration upsert.

## Scope
- **IN**: agents table + migration, agent self-registration, `/agent/self`, `/projects/discovered`,
  dashboard DB reads for agent list, settings CRUD to DB, env/file cleanup
- **OUT**: `packages/core/src/config.ts` `parseConfig()` removal (not imported by any active
  code path — leave for backward compat), multi-dashboard shared registry, agent auto-discovery
  via mDNS or Tailscale, paginated projects discovery

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/` | +1 new file (`agents.ts`), +1 export in `index.ts` |
| `packages/db/src/schema/` | New migration SQL generated |
| `apps/agent/src/` | +2 route files, +2 route registrations in `server.ts`, startup upsert |
| `apps/nextjs/src/lib/get-client.ts` | Replace `readFileSync(dashboard.json)` with DB query |
| `apps/nextjs/src/app/actions/settings.ts` | Replace `writeFileSync(dashboard.json)` with DB insert/delete |
| `deploy/nexus-agent.service` | Remove `NEXUS_PROJECTS_DIR` line |
| `deploy/install.sh` | Remove `agents.toml` seeding block |
| `deploy/hooks.d/pre-push/01-deploy` | Add `db:migrate` step post-install |

## Risks
| Risk | Mitigation |
|------|-----------|
| DB unavailable on agent startup → no self-registration | Log warning, continue — agent still serves HTTP, self-registers on next restart |
| Dashboard has no agents in DB after migration | Fallback to localhost:7400 preserved in `get-client.ts` until first self-registration |
| `projects_dir` scan slow on large trees | Truncate at 100, 1-level deep scan only (no deep recursion), 5s TTL cache |
| Breaking deploy on machines without DB migration run | `01-deploy` hook runs `pnpm db:migrate` before starting agent |
