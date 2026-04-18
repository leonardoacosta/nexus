## ADDED Requirements

### Requirement: Read-only enforcement at consumer layer
Every dashboard Server Action and route handler in `apps/nextjs/src/app/` that reads from the database MUST type its DB handle as `ReadOnlyDb` (from `@nexus/db/readonly`). The full `Db` type SHALL NOT be reachable from any consumer outside the factory at `apps/nextjs/src/lib/db.ts`.

#### Scenario: A new action attempts a write
- **GIVEN** a developer adds a new Server Action that calls `getReadOnlyDb()` and chains `.insert(...)`
- **WHEN** they run `pnpm tsc --noEmit`
- **THEN** TypeScript MUST fail with an error indicating `.insert` does not exist on `ReadOnlyDb`

### Requirement: Single public read API
The factory at `apps/nextjs/src/lib/db.ts` SHALL export ONLY `getReadOnlyDb()`. The full-Db function SHALL be a private helper (e.g. `_getDb()`) used internally by `getReadOnlyDb()` to obtain the underlying connection.

#### Scenario: Future consumer attempts to import getDb
- **GIVEN** a developer writes `import { getDb } from '@/lib/db'`
- **WHEN** they run `pnpm tsc --noEmit`
- **THEN** TypeScript MUST fail with an unresolved-export error
