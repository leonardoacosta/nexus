# Design: folder-based-project-autodiscovery

## The three divergent project-list notions (exploration 2026-05-19)

1. **spec-watcher** — `services/spec-watcher/poller.ts:51` → `getProjects()` →
   `config-loader.ts:52` reads static `~/.claude/scripts/config/projects.json`,
   filtered to dirs with `openspec/`. No filesystem scan. Empty on homelab.
2. **/projects** — `routes/projects.ts:43` `session.projectId ?? "(unregistered)"`.
   Purely session-derived; with nx-tbxgd all sessions have null projectId →
   one "(unregistered)" bucket.
3. **scanner** — `routes/projects-discovered.ts:212 scanProjects()` exists but
   matches only `.git`, runs only on `GET /projects/discovered`, never at
   startup, needs `agent.projectsDir`.

None feeds the others; none auto-discovers by folder content at startup.

## Decision: one scanner → registry → everything

- Reuse/extend `scanProjects()` to match `.git` **OR** `openspec/` (spec-only
  repos matter for spec-watcher). Trigger it at agent startup + on an interval,
  writing through the existing `db/project-registry.upsertProjectLocations`.
- `spec-watcher`'s `loadProjectRegistry` reads the registry instead of (or in
  addition to, registry-first) the static `projects.json`.
- `routes/projects.ts` aggregates from the registry and filters `hidden`.
- Add a `hidden` boolean to the `projects`/`projectLocations` schema (a
  dedicated flag — do NOT overload the existing `status` field, which is
  archival lifecycle). `PATCH /projects/:id` toggles it. The scanner upsert
  MUST preserve an existing `hidden=true` (sticky) — re-discovery never clears it.
- ProjectsView gains a per-row remove affordance calling the PATCH.

This also feeds nx-tbxgd: once the registry is populated, session
project-resolution can map cwd→registered project (nx-tbxgd additionally needs
the process-watcher cwd fix; complementary, not blocked here).

## Trade-offs (locked from exploration)

- Marker `.git` OR `openspec/` (not `.git`-only) — spec-only repos.
- Startup+periodic (not on-demand) — on-demand is why it's empty everywhere.
- Dedicated `hidden` flag (not `status="hidden"`) — status is archival; scanner must honor exclude.

## Out of scope

- The process-watcher cwd capture half of nx-tbxgd (separate; this only makes
  the registry exist for the resolver to consult).
- Credential divergence (separate spec: fix-credential-source-divergence).
