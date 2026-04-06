# Change: Fix Project Discovery — Count Loss, Tilde Expansion, Cross-Machine Dedup

## Why

The project discovery pipeline has three P1 bugs that silently destroy data: actual session counts
are replaced with boolean flags before they ever reach the client; the `~` in `projectsDir` is
already expanded in the route handler but the `AgentDiscoveredProject` interface never carried
count fields, so the mapping code in the Next.js client falls back to boolean-based guessing; and
projects dirs stored with a leading `~` can cause ENOENT on some code paths where expansion is
skipped. Together these bugs make the dashboard session counts unreliable. Five additional P2/P3
issues (cross-machine dedup, stale project accumulation, symlink duplicates, missing
path-to-registry mapping, and cache freshness) further degrade the Projects view at scale.

## What Changes

- **BREAKING** `AgentDiscoveredProject` interface gains `activeSessions: number` and
  `totalSessions: number` fields; `hasActiveSessions: boolean` is removed
- **BREAKING** Dedup key changes from `name|path` string to normalized absolute path (symlink
  resolved, lowercase on macOS); cross-machine canonical identity uses git remote URL when
  available
- Route handler `handleGetDiscoveredProjects` counts matching sessions (active and total)
  instead of reducing them to a boolean
- Tilde expansion in `expandProjectsDir` is already present in the route but must be guarded
  throughout all call sites; `agent.projectsDir` DB field must be expanded before use
- Stale project eviction: aggregated view drops projects unseen for >1 hour
- Symlink dedup: canonical path resolved before inserting into the map
- `agent` field on merged entries tracks the first agent to report the project and is not
  overwritten by later agents during dedup
- Empty `projectsDir` now logs an explicit info-level notice instead of silently returning
- Cache TTL surfaced in response header `X-Cache-Age`
- Input validation added for `projectsDir` field (rejects path traversal, empty after trim)

## Impact

- Affected specs: `project-dir-scan`
- Affected code:
  - `apps/agent/src/routes/projects-discovered.ts` — `AgentDiscoveredProject`, route handler
  - `apps/nextjs/src/lib/agent-client.ts:159-205` — `fetchDiscoveredProjects`, dedup map key,
    count mapping
  - `packages/core` — `DiscoveredProject` interface (ensure `active_sessions`/`total_sessions`
    are `number`, not derived from boolean)
- Breaking: any consumer of `GET /projects/discovered` that reads `hasActiveSessions` must
  migrate to `activeSessions` / `totalSessions`
- Non-breaking: `DiscoveredProject` in core already uses `active_sessions: number` — the
  fix removes the lossy boolean translation in the client
