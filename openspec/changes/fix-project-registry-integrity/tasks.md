## 1. Schema — git_remote_url column and composite unique

- [x] 1.1 Add `git_remote_url` text column (nullable) to `packages/db/src/schema/projects.ts`
- [x] 1.2 Drop the plain `name` UNIQUE constraint; add `(name, git_remote_url)` composite UNIQUE (NULL == NULL treated as distinct so two local-only projects with the same name can coexist)
- [x] 1.3 Generate migration: `pnpm db:generate` and review the SQL diff
- [x] 1.4 Export `git_remote_url` from schema index if not already present

## 2. Module-level dedup set (P1)

- [x] 2.1 Move `seenCanonicalPaths` in `apps/agent/src/routes/projects-discovered.ts` from inside the request loop to module scope (reset on each cache-miss compute cycle, NOT across requests — reset at top of the scan block before the `for` loop)
- [x] 2.2 Add unit test: two `handleGetDiscoveredProjects` calls in the same process with a symlinked dir should not double-upsert

## 3. Await upsert before response (P2 — race)

- [x] 3.1 Change the fire-and-forget `upsertProjectLocations(…).catch(…)` in `projects-discovered.ts:268-270` to `await upsertProjectLocations(…)` (wrap with try/catch; log on error but still return the response)
- [x] 3.2 Remove the orphaned `.catch` handler

## 4. Retry select after insert (P2 — silent skip)

- [x] 4.1 In `apps/agent/src/db/project-registry.ts:40-42`, after the `onConflictDoNothing` insert, retry the `select` once if the first result is empty (covers the race where another agent inserts concurrently)
- [x] 4.2 If both attempts return empty, log a `warn` with `{ name }` and continue (same as today, but without silent location loss)
- [x] 4.3 Add unit test: concurrent upsert scenario

## 5. Persist git_remote_url in project_locations

- [x] 5.1 Add `gitRemoteUrl` field to `ProjectToUpsert` interface in `project-registry.ts`
- [x] 5.2 Update `upsertProjectLocations` to write `git_remote_url` into `project_locations` on insert and upsert
- [x] 5.3 Pass `gitRemoteUrl` from `projects-discovered.ts` when building the `toUpsert` array

## 6. Active window alignment (P3)

- [x] 6.1 Change `ACTIVE_SESSION_WINDOW_MS` in `projects-discovered.ts` from `5 * 60 * 1_000` to `60 * 60 * 1_000` (1 hour)
- [x] 6.2 Update the spec comment on the constant

## 7. Path validation — absolute prefix (P3)

- [x] 7.1 After `expandProjectsDir`, verify the resolved path starts with `/home/` or `/Users/`; if not, return `400` with a descriptive error
- [x] 7.2 Add test: a relative path that resolves outside `/home/`/`/Users/` must be rejected

## 8. discoveredAt sentinel (P2)

- [x] 8.1 In `apps/nextjs/src/app/actions/projects.ts:51` and `:123`, remove `?? new Date().toISOString()` fallback
- [x] 8.2 Assert `discoveredAt` is non-null at query time (if the column has `defaultNow()`, it should never be null post-schema fix)
- [x] 8.3 Update `CanonicalProject` interface if `discoveredAt` is typed as `string | null`; make it `string` (non-nullable)

## 9. Unassigned session filter (P2)

- [x] 9.1 In `apps/nextjs/src/app/projects/[name]/page.tsx:21-23`, remove the `s.project === null && projectName === "Unassigned"` branch
- [x] 9.2 Filter should be simply `s.project === projectName`
- [x] 9.3 If `fetchProject("Unassigned")` returns null, the page renders the "Project not found in registry" state — that is the correct behavior

## 10. Remove Rust /projects/discovered endpoint (P2 — BREAKING)

- [x] 10.1 Delete `crates/nexus-agent/src/http_handlers/discovered_projects.rs`
- [x] 10.2 Remove the route registration in `crates/nexus-agent/src/http_handlers/mod.rs`
- [x] 10.3 Verify `cargo build -p nexus-agent` passes
- [x] 10.4 Update `CLAUDE.md` architecture notes if `/projects/discovered` is mentioned for the Rust agent

## 11. Stale project cleanup job (P3)

- [x] 11.1 Add `cleanupStaleProjectLocations(db: Db): Promise<void>` to `project-registry.ts`
  - DELETE `project_locations` where `status = 'missing'` AND `last_discovered_at < NOW() - 30 days`
  - After deletion: UPDATE `projects` SET `status = 'archived'` WHERE no remaining active/missing locations exist
- [x] 11.2 Register the cleanup job in the Bun agent startup (run once at boot, then every 24 h)
- [x] 11.3 Add unit test: locations missing for 31 days are removed; locations missing for 29 days are retained

## 12. GCF — Tag group session counts

- [x] 12.1 In `fetchProjects()` (or a new `fetchProjectTagGroups()` action), aggregate `activeSessions` and `totalSessions` per tag across all projects
- [x] 12.2 Expose as `tagGroups: { tag: string; activeSessions: number; totalSessions: number }[]` in the `ProjectsResult`
- [x] 12.3 Render counts in the `/projects` table header (existing `ProjectsPoller` or table component)

## 13. GCF — Per-agent presence badges on detail page

- [x] 13.1 `ProjectSettingsPanel` or a sibling component SHALL render an agent badge for each `CanonicalProject.locations` entry showing: agent name, dot (● active / ○ missing), and path tooltip
- [x] 13.2 Use existing `ProjectCard` badge rendering logic where possible to avoid duplication
