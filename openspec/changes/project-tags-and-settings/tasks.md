# Implementation Tasks

<!-- beads:epic:nx-9pkn -->

## API Batch

- [x] [1.1] [P-1] Fix `agent-client.ts`: add `x-nexus-secret: process.env.NEXUS_ATTACH_SECRET` header to `fetchWithRetry` and `startSession` fetch; fix `startSession` error path to use `res.text()` fallback instead of `res.json()` on non-ok response [owner:api-engineer] [beads:nx-54ae]
- [x] [1.2] [P-1] Fix `agent-routing.ts` `resolveAttachAgent`: return `{ agentName: string; isFallback: boolean }` using `loc.agentName` not `loc.agentId`; update `ProjectRow` and `ProjectCard` call sites accordingly [owner:api-engineer] [beads:nx-r9ew]
- [ ] [1.3] [P-2] Add `tags: string[] | null` and `description: string | null` to `CanonicalProject` in `packages/core/src/types/project.ts`; update `fetchProjects` select in `apps/nextjs/src/app/actions/projects.ts` to include both columns [owner:types-engineer] [beads:nx-8zl6]
- [ ] [1.4] [P-2] Add `fetchProject(name: string): Promise<CanonicalProject | null>` and `updateProject(id: string, data: { tags?: string[]; description?: string }): Promise<void>` to `apps/nextjs/src/app/actions/projects.ts`; normalize tags (trim + lowercase) in `updateProject` [owner:api-engineer] [beads:nx-e5u5]

## UI Batch

- [ ] [2.1] [P-1] Update `ProjectsTable.tsx`: group `CanonicalProject[]` by `project.tags?.[0] ?? "uncategorized"`; render sticky uppercase section header rows between groups; Uncategorized group last; preserve existing row design [owner:ui-engineer] [beads:nx-4qpw]
- [ ] [2.2] [P-1] Create `ProjectSettingsPanel.tsx`: read-only name + location paths; editable description textarea; tag chip-input (add via Enter/comma, remove via ×); Save button calls `updateProject` with inline success/error feedback [owner:ui-engineer] [beads:nx-uwu5]
- [ ] [2.3] [P-2] Update `/projects/[name]/page.tsx`: call `fetchProject(name)` for canonical data; render `<ProjectSettingsPanel>` unconditionally above sessions; show "Project not found in registry" if `fetchProject` returns null [owner:ui-engineer] [beads:nx-go0b]
