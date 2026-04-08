# Implementation Tasks

<!-- beads:epic:nx-xa0v -->

## API Batch

- [x] [1.1] [P-1] Create `apps/nextjs/src/lib/projects.ts` with `PROJECT_SELECT_FIELDS`, `DEFAULT_PRIORITY`, and `buildCanonicalProject()` helper [owner:api-engineer] [beads:nx-q2mt]
- [x] [1.2] [P-1] Export `TtlCache` class from `agent-client.ts`; add optional `cache` constructor param to `AgentClient` [owner:api-engineer] [beads:nx-1t70]
- [x] [1.3] [P-2] Hoist module-level `TtlCache` in `get-client.ts` and inject into `AgentClient` constructor [owner:api-engineer] [beads:nx-aj7o]

## UI Batch

- [x] [2.1] [P-1] Refactor `fetchProjects()` in `actions/projects.ts` to use `PROJECT_SELECT_FIELDS` + `buildCanonicalProject()` [owner:ui-engineer] [beads:nx-dhqb]
- [x] [2.2] [P-1] Refactor `fetchProject()` in `actions/projects.ts` to use `PROJECT_SELECT_FIELDS` + `buildCanonicalProject()` [owner:ui-engineer] [beads:nx-lq4d]
- [x] [2.3] [P-1] Refactor `GET /api/projects` route to use `PROJECT_SELECT_FIELDS` + `buildCanonicalProject()` [owner:ui-engineer] [beads:nx-ldty]
- [x] [2.4] [P-2] Fix imports in `get-client.ts` to use `@nexus/db` barrel only [owner:ui-engineer] [beads:nx-fgnp]
- [x] [2.5] [P-2] Fix imports in `actions/settings.ts` to use `@nexus/db` barrel only [owner:ui-engineer] [beads:nx-x7bt]
- [x] [2.6] [P-2] Fix imports in `api/projects/route.ts` to use `@nexus/db` barrel only [owner:ui-engineer] [beads:nx-tvb3]

## E2E Batch

- [ ] [3.1] Run `pnpm build` to verify no import errors [owner:e2e-engineer] [beads:nx-hrtf]
- [ ] [3.2] Grep `apps/nextjs/src/` for `"@nexus/db/` sub-path imports and `?? 999` -- zero matches expected [owner:e2e-engineer] [beads:nx-di00]
- [ ] [3.3] Run existing test suite to confirm no regressions [owner:e2e-engineer] [beads:nx-npno]
