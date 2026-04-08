# Spec: Layering Enforcement

## MODIFIED Requirements

### Requirement: Route all DB access through @nexus/db barrel

All files under `apps/nextjs/` MUST import DB tables and query operators exclusively from the `@nexus/db` package barrel (`packages/db/src/index.ts`). No file SHALL import from internal sub-paths of `@nexus/db`.

#### Scenario: get-client.ts uses barrel imports

**Given** `apps/nextjs/src/lib/get-client.ts` imports `agents` and `eq`
**When** the import source is checked
**Then** both come from `@nexus/db` (the barrel), not from internal paths

#### Scenario: settings.ts uses barrel imports

**Given** `apps/nextjs/src/app/actions/settings.ts` imports `agents` table and `eq`
**When** the import source is checked
**Then** both come from `@nexus/db`

#### Scenario: projects route uses barrel imports

**Given** `apps/nextjs/src/app/api/projects/route.ts` imports tables and operators
**When** the import source is checked
**Then** all come from `@nexus/db`

#### Scenario: no internal @nexus/db paths remain

**Given** a grep for import paths under `apps/nextjs/`
**When** searching for `from "@nexus/db/` (sub-path imports)
**Then** zero matches are found
