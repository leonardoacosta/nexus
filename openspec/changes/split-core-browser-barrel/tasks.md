# Implementation Tasks

<!-- beads:epic:nx-xish -->

## DB Batch

(none for this spec)

## API Batch

- [ ] [1.1] [P-1] Add `./node` subpath export to packages/core/package.json [owner:api-engineer] [beads:nx-uk65]
- [ ] [1.2] [P-1] Move safeSpawn/expandTilde/parseConfig/logger exports from index.ts to new packages/core/src/node.ts [owner:api-engineer] [beads:nx-ft36]
- [ ] [1.3] [P-2] Update all apps/agent imports from `@nexus/core` to `@nexus/core/node` for moved symbols [owner:api-engineer] [beads:nx-6vsz]
- [ ] [1.4] [P-2] Add ESLint guard: browser barrel cannot import from packages/core/src/node.ts [owner:api-engineer] [beads:nx-2gu3]

## UI Batch

- [ ] [2.1] [P-1] Delete duplicated SpecTransitionEvent/SpecEventsFrame in apps/nextjs/src/app/specs/spec-events-subscriber.tsx:25-48; import from @nexus/core [owner:ui-engineer] [beads:nx-kb16]
- [ ] [2.2] [P-2] Verify production build of apps/nextjs succeeds with `next build` [owner:ui-engineer] [beads:nx-bc8p]

## E2E Batch

- [ ] [3.1] Add unit test in packages/core that imports the browser barrel and asserts no node:os/node:path/node:fs in resolved deps [owner:e2e-engineer] [beads:nx-raug]
