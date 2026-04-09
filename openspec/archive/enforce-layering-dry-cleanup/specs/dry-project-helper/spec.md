# Spec: DRY Project Helper

## ADDED Requirements

### Requirement: Extract shared buildCanonicalProject helper

A new module `apps/nextjs/src/lib/projects.ts` MUST export:
- `PROJECT_SELECT_FIELDS` -- the canonical Drizzle select object for the projects+locations+agents join
- `buildCanonicalProject(rows)` -- maps join result rows into a `CanonicalProject` with aggregated locations, sessions, and correct fallback defaults

All three consumers (`fetchProjects`, `fetchProject`, `GET /api/projects`) MUST use these exports instead of inline mapping.

#### Scenario: fetchProjects uses shared helper

**Given** `apps/nextjs/src/app/actions/projects.ts` calls `fetchProjects()`
**When** the function builds its result
**Then** it uses `PROJECT_SELECT_FIELDS` for the select clause and `buildCanonicalProject()` for row mapping

#### Scenario: fetchProject uses shared helper

**Given** `apps/nextjs/src/app/actions/projects.ts` calls `fetchProject(name)`
**When** the function builds its result
**Then** it uses `PROJECT_SELECT_FIELDS` for the select clause and `buildCanonicalProject()` for row mapping

#### Scenario: GET /api/projects uses shared helper

**Given** `apps/nextjs/src/app/api/projects/route.ts` handles a GET request
**When** the handler builds its response
**Then** it uses `PROJECT_SELECT_FIELDS` for the select clause and `buildCanonicalProject()` for row mapping

#### Scenario: single point of change for schema additions

**Given** a new column is added to `projectLocations`
**When** it needs to appear in the canonical project view
**Then** only `PROJECT_SELECT_FIELDS` and `buildCanonicalProject()` need updating (one file)
