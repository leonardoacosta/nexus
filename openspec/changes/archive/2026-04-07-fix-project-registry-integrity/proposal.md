# Change: Fix project-registry integrity gaps

## Why

The canonical project registry (added in `add-project-registry`) has 10 correctness gaps and
3 GCF opportunities discovered during audit. The gaps cause duplicate upserts, silent data
loss on race conditions, stale data accumulating forever, and a cross-agent identity collision
vector. Left unresolved these degrade the reliability of the `/projects` view and the detail
page over time.

## What Changes

- **P1 — Persistent dedup set:** `seenCanonicalPaths` in `projects-discovered.ts` is recreated
  each HTTP request; move it to module scope so symlinked duplicates are filtered across
  invocations.
- **P2 — Retry select after insert:** `upsertProjectLocations` silently skips a project if the
  post-insert select returns empty (race condition); add a retry or transaction.
- **P2 — Await upsert before responding:** the fire-and-forget `upsertProjectLocations(…).catch`
  pattern allows the 5 s TTL cache to expire and be re-read before the DB write completes;
  await the upsert before sending the HTTP response.
- **P2 — Rust agent does not upsert to DB:** `discovered_projects.rs` returns project data but
  never writes to the DB; projects discovered only by the Rust agent are invisible in the
  canonical list. Fix: remove the Rust discovery endpoint and route through the Bun agent
  instead. **BREAKING** (removes Rust `/projects/discovered`).
- **P2 — Project identity collision on name:** `projects.name` unique constraint allows two
  unrelated repositories named `nx` (one per machine) to collide; add `git_remote_url` column
  and `(name, git_remote_url)` composite unique constraint.
- **P2 — `discoveredAt` sentinel:** `null` `discoveredAt` is replaced with `new Date()` on
  every fetch, making the discovery timestamp non-deterministic; use a DB-level `defaultNow()`
  guarantee and treat `null` in the type as an error rather than a fallback.
- **P2 — `Unassigned` session filter:** the detail page checks `s.project === null &&
  projectName === "Unassigned"` but `fetchProject("Unassigned")` queries the real DB — valid
  only if a project named "Unassigned" exists; remove the null shortcut.
- **P3 — Align active window:** `ACTIVE_SESSION_WINDOW_MS` is 5 min but `QUERY_WINDOW_HOURS`
  is 24 h; sessions older than 5 min appear in results with 0 active count but are included in
  the response set; align the active window to 1 h.
- **P3 — Require absolute path prefix:** `expandProjectsDir` accepts relative paths resolved
  against CWD; require expanded paths to start with `/home/` or `/Users/`.
- **P3 — Stale project cleanup job:** projects with `status='missing'` accumulate forever; add
  a periodic job to archive locations missing for >30 days and prune project rows with no
  remaining active locations.
- **GCF — Git remote URL as canonical identity:** `gitRemoteUrl` is already collected per
  discovery but not persisted; store it in `project_locations` and use it for cross-agent
  dedup (aligns with `cross-machine project dedup` requirement in `project-dir-scan` spec).
- **GCF — Session counts per tag group:** the `/projects` table header should aggregate
  active/total session counts grouped by tag.
- **GCF — Per-agent presence badges on detail page:** the detail page should show which agents
  have an active location for the project.

## Impact

- Affected specs: `project-registry`, `project-dir-scan`
- Affected code:
  - `apps/agent/src/routes/projects-discovered.ts` (dedup set, active window, path validation, await upsert)
  - `apps/agent/src/db/project-registry.ts` (retry select, stale cleanup job)
  - `packages/db/src/schema/projects.ts` (git_remote_url column, composite unique)
  - `apps/nextjs/src/app/actions/projects.ts` (discoveredAt sentinel, tag group counts)
  - `apps/nextjs/src/app/projects/[name]/page.tsx` (Unassigned filter)
  - `crates/nexus-agent/src/http_handlers/discovered_projects.rs` (**BREAKING** — endpoint removed)
