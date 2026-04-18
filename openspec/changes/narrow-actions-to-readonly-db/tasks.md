# Implementation Tasks

<!-- beads:epic:nx-rf6r -->

## DB Batch

(none — purely a consumer-layer refactor, no schema or DB-package changes)

## API Batch

- [ ] [1.1] [P-1] Migrate apps/nextjs/src/app/actions/health.ts from getDb() to getReadOnlyDb() [owner:api-engineer] [beads:nx-r24i]
- [ ] [1.2] [P-1] Migrate apps/nextjs/src/app/actions/projects.ts from getDb() to getReadOnlyDb() [owner:api-engineer] [beads:nx-bp5b]
- [ ] [1.3] [P-1] Migrate apps/nextjs/src/app/actions/sessions.ts from getDb() to getReadOnlyDb() [owner:api-engineer] [beads:nx-1czw]
- [ ] [1.4] [P-1] Migrate apps/nextjs/src/app/actions/settings.ts from getDb() to getReadOnlyDb() [owner:api-engineer] [beads:nx-71o9]
- [ ] [1.5] [P-1] Migrate apps/nextjs/src/app/api/projects/route.ts from getDb() to getReadOnlyDb() [owner:api-engineer] [beads:nx-bket]
- [ ] [1.6] [P-2] Run pnpm tsc --noEmit; if any new errors surface, investigate (likely a real write site or ReadOnlyDb method gap) [owner:api-engineer] [beads:nx-sdas]
- [ ] [1.7] [P-3] Collapse getDb() to private _getDbInternal() in apps/nextjs/src/lib/db.ts; remove the public getDb export; update factory comment [owner:api-engineer] [beads:nx-56xi]

## E2E Batch

- [ ] [2.1] Add unit test asserting `getReadOnlyDb()` is the only export from apps/nextjs/src/lib/db.ts (no `getDb` export) [owner:e2e-engineer] [beads:nx-g61t]
