# Tasks: folder-based-project-autodiscovery

<!-- beads:epic:nx-lo8xr -->
<!-- beads:feature:nx-znjyo -->

## DB Batch

- [x] 1.1 Add a dedicated `hidden` boolean (default false) to the
  `projects` and `projectLocations` tables in `packages/db/src/schema/projects.ts`
  (do NOT overload the existing archival `status` field). Generate the
  migration via drizzle-kit. [beads:nx-qdbxb]

## API Batch

- [ ] 2.1 Extend the discovery scanner (`apps/agent/src/routes/projects-discovered.ts`
  `scanProjects()`) to match a directory containing `.git` **OR** `openspec/`
  (currently `.git`-only). [beads:nx-wcao8]
- [ ] 2.2 Add a startup + periodic-interval trigger that runs the scanner over
  configured dev-roots and writes through `db/project-registry`
  `upsertProjectLocations`. The upsert MUST preserve an existing
  `hidden=true` (sticky — re-discovery never clears it). [beads:nx-d71ob]
- [ ] 2.3 `apps/agent/src/services/spec-watcher/poller.ts` — enumerate projects
  from `db/project-registry` (registry-first), not solely the static
  `~/.claude/scripts/config/projects.json`, so `/specs` reflects discovered
  repos' openspec changes. [beads:nx-59cnu]
- [ ] 2.4 `apps/agent/src/routes/projects.ts` — aggregate from the registry and
  exclude rows where `hidden` is set. [beads:nx-jbrmz]
- [ ] 2.5 `PATCH /projects/:id` route — set/clear the persisted `hidden` flag. [beads:nx-zcv7d]

## UI Batch

- [ ] 3.1 `apps/swift/nexus-mac/Sources/Dashboard/ProjectsView.swift` — add a
  per-row remove affordance (button/context menu) that calls `PATCH
  /projects/:id` with `hidden=true` and drops the row from the list. [beads:nx-m4474]

## E2E Batch

- [ ] 4.1 On the homelab agent (has `/home/nyaptor/dev/nx/openspec/changes`,
  27 changes): redeploy, confirm the scanner auto-discovers the repo →
  `GET /projects` lists it (not just "(unregistered)") AND `GET /specs` is
  no longer `[]`. Paste curl/JSON proof. [beads:nx-exbta]
- [ ] 4.2 Hide a discovered project via `PATCH /projects/:id`, confirm it
  disappears from `GET /projects`, then trigger a rescan and confirm it
  STAYS hidden (sticky exclude). Paste proof. [beads:nx-3ynb9]
