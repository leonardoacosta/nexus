# Implementation Tasks

<!-- beads:epic:nx-zbgg -->

## DB Batch

- [x] [1.1] [P-1] Add ReadOnlyDb type narrowing in packages/db/src/readonly.ts (omits insert/update/delete/execute/transaction) [owner:db-engineer] [beads:nx-wd5k]
- [x] [1.2] [P-1] Add `./readonly` subpath export to packages/db/package.json [owner:db-engineer] [beads:nx-lker]

## API Batch

- [x] [2.1] [P-1] Audit agent HTTP API: list endpoints needed to cover current nextjs write paths (sessions, projects, settings) [owner:api-engineer] [beads:nx-ejir]
- [x] [2.2] [P-1] Add missing agent endpoints for sessions writes (mirror actions/sessions.ts mutations) [owner:api-engineer] [beads:nx-et2w]
- [x] [2.3] [P-1] Add missing agent endpoints for projects writes (mirror actions/projects.ts + lib/projects.ts) [owner:api-engineer] [beads:nx-gb5d]
- [x] [2.4] [P-1] Add missing agent endpoints for settings writes (mirror actions/settings.ts) [owner:api-engineer] [beads:nx-v16c]
- [x] [2.5] [P-2] Convert apps/nextjs/src/app/actions/sessions.ts writes to HTTP calls to agent [owner:api-engineer] [beads:nx-0p8r]
- [x] [2.6] [P-2] Convert apps/nextjs/src/app/actions/projects.ts writes to HTTP calls [owner:api-engineer] [beads:nx-zbq8]
- [x] [2.7] [P-2] Convert apps/nextjs/src/app/actions/settings.ts writes to HTTP calls [owner:api-engineer] [beads:nx-3v0r]
- [x] [2.8] [P-2] Convert apps/nextjs/src/app/api/projects/route.ts writes to HTTP calls [owner:api-engineer] [beads:nx-ovi6]
- [x] [2.9] [P-2] Convert apps/nextjs/src/lib/projects.ts writes to HTTP calls [owner:api-engineer] [beads:nx-0jaa]
- [x] [2.10] [P-2] Update apps/nextjs/src/lib/get-client.ts to import ReadOnlyDb only [owner:api-engineer] [beads:nx-2r89]
- [x] [2.11] [P-3] Add ESLint rule blocking imports of `Db` (full) from apps/nextjs (allow ReadOnlyDb only) [owner:api-engineer] [beads:nx-4izs]

## UI Batch

- [x] [3.1] [P-2] Verify dashboard works against agent endpoints (no direct writes) [owner:ui-engineer] [beads:nx-b2k0]

## E2E Batch

- [ ] [4.1] Add E2E test asserting all dashboard mutations succeed via agent HTTP path [owner:e2e-engineer] [beads:nx-4wue]
- [ ] [4.2] Add unit test asserting ReadOnlyDb type rejects .insert/.update/.delete at compile time [owner:e2e-engineer] [beads:nx-aiuq]
