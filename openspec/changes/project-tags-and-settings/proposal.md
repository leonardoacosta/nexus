# Proposal: Project Tags and Settings Panel

## Change ID
`project-tags-and-settings`

## Summary
Add editable tags and description to projects, group the `/projects` table by tag, and render an always-visible settings panel on `/projects/[name]`. Includes two blocking bug fixes in `agent-client.ts` (missing auth header) and `agent-routing.ts` (UUID vs name mismatch).

## Context
- Extends: `packages/core/src/types/project.ts`, `apps/nextjs/src/app/actions/projects.ts`, `apps/nextjs/src/lib/agent-client.ts`, `apps/nextjs/src/lib/agent-routing.ts`, `apps/nextjs/src/components/ProjectsTable.tsx`, `apps/nextjs/src/app/projects/[name]/page.tsx`
- Related: `add-project-registry` (archived 2026-04-06) — `tags text[]` and `description text` columns already exist in the `projects` DB table; no migration needed

## Motivation
Projects are logged in the registry but treated as opaque entries: no description, no tagging, no metadata editing. Leo uses 4 project categories (`personal`, `priceless`, `b&b`, `homelab`) to organize 34 projects; without tag grouping the flat table is dense and unscannable by intent.

The `/projects/[name]` detail page currently shows only sessions — visiting an idle project shows an empty state with no context, no paths, no way to understand or configure the project.

Two silent bugs compound the problem: `agent-client.ts` never sends `x-nexus-secret` so all session fetches return 401 (silently swallowed), and `resolveAttachAgent` returns a UUID but `AgentClient.startSession()` expects an agent config name, causing "Agent not found: undefined" on every Start Session click.

## Requirements

### Req-1: Agent Client Auth + Name Resolution Fixes

`agent-client.ts` must send `x-nexus-secret: $NEXUS_ATTACH_SECRET` on every request (the agent applies this check to all REST routes). The `startSession` error path must use `res.text()` fallback before attempting `JSON.parse` to avoid `SyntaxError` on plain-text `"Unauthorized"` responses.

`resolveAttachAgent` in `agent-routing.ts` must return `agentName` (the config name, e.g., "omarchy") not `agentId` (UUID). Call sites in `ProjectRow` and `ProjectCard` must pass the name to `startSession`.

### Req-2: Tags and Description on CanonicalProject

`CanonicalProject` in `packages/core` must expose `tags: string[] | null` and `description: string | null`. `fetchProjects()` must select both columns from the DB. A `fetchProject(name: string)` action must return a single `CanonicalProject | null` by project name (for the detail page). An `updateProject(id: string, data: { tags?: string[]; description?: string })` server action must persist changes to the `projects` table.

### Req-3: Tag-Grouped Table on /projects

The `/projects` table must group rows under sticky uppercase section headers keyed by the project's first tag. Projects with no tags fall under an "Uncategorized" section rendered last. Section headers display the tag name and a project count. The existing row design (monospace name, location dots, session counts, hover-reveal Start button) is preserved unchanged within each group.

### Req-4: Settings Panel on /projects/[name]

`/projects/[name]` must always render a settings panel at the top of the page, regardless of session count. The panel displays: project name (read-only), filesystem path per location with agent name (read-only), description (editable `<textarea>`), and tags (editable chip-input). A "Save" button calls `updateProject`. Below the settings panel, the existing sessions section remains (unchanged grid/empty-state). If the project name is not in the registry, the page renders a "Project not found in registry" message instead of the settings panel.

## Scope
- **IN**: `CanonicalProject` type extension, `fetchProjects` select, `fetchProject` + `updateProject` server actions, agent-client auth header, `resolveAttachAgent` name fix, grouped table with section headers, settings panel component, detail page restructure
- **OUT**: Tag management page, per-tag filtering on list, tag rename/delete, bulk assignment, project deletion, sorting by tag, session counts aggregated per tag group

## Impact
| Area | Change |
|------|--------|
| `packages/core/src/types/project.ts` | Add `tags` + `description` to `CanonicalProject` |
| `apps/nextjs/src/app/actions/projects.ts` | Add fields to select; add `fetchProject` + `updateProject` |
| `apps/nextjs/src/lib/agent-client.ts` | Add `x-nexus-secret` header to all fetches |
| `apps/nextjs/src/lib/agent-routing.ts` | Return `agentName` not `agentId` |
| `apps/nextjs/src/components/ProjectsTable.tsx` | Group rows by first tag with sticky section headers |
| `apps/nextjs/src/app/projects/[name]/page.tsx` | Fetch canonical project; always render settings panel |
| `apps/nextjs/src/components/ProjectSettingsPanel.tsx` | New: description textarea + tag chip-input + save |

## Risks
| Risk | Mitigation |
|------|-----------|
| `NEXUS_ATTACH_SECRET` absent from Next.js env | `nexus-dashboard.service` already has `EnvironmentFile=~/.env`; secret confirmed present |
| `updateProject` race with discovery upsert | Last-write-wins acceptable — user metadata (tags/description) vs discovery data (paths/sessions) are non-overlapping columns |
| Tags with leading/trailing whitespace | Normalize to `tag.trim().toLowerCase()` on input before DB write |
