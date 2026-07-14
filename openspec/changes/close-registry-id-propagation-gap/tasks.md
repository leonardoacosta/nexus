<!-- beads:epic:nx-2yy5p -->
<!-- beads:feature:nx-ybt3x -->

# Implementation Tasks

## API Batch

- [x] [2.1] Include `registryId` in `GET /projects/discovered` response by querying the `projects` table for a matching row; `null` when no registry row exists yet [owner:api-engineer] [type:api] [beads:nx-4uwok]
- [x] [2.2] Add `registryId: string | null` to the agent-side `AgentDiscoveredProject` interface [owner:api-engineer] [type:api] [beads:nx-nio52]
- [x] [2.3] Add `registryId?: string | null` to `packages/core`'s `DiscoveredProject` type [owner:types-engineer] [type:api] [beads:nx-apjib]

## UI Batch

- [x] [3.1] N/A for nx — resolved without a code change. `apps/nextjs/src/lib/agent-client.ts` does not exist in this repo (nx uses `apps/web`, not `apps/nextjs`; confirmed via grep — no TS consumer of `AgentDiscoveredProject`/`DiscoveredProject` exists anywhere client-side). `registryId` already flows end-to-end through both wire-format types (API Batch 2.2/2.3); there is no intermediate client mapping hop to update. Task text was authored against a stale/generic template path — see close-registry-id-propagation-gap's original bead nx-611m. [owner:ui-engineer] [type:ui] [beads:nx-288h4]

## E2E Batch

- [ ] [4.1] Route unit test: registered project's discovery response carries its registryId; unregistered project's registryId is null [owner:e2e-engineer] [type:testing] [beads:nx-idfzy]
- [x] [4.2] N/A for nx — same root cause as [3.1]: no TS client mapping exists to test. Superseded by [4.1], which already covers registryId at the one real boundary (the agent route). [owner:e2e-engineer] [type:testing] [beads:nx-hp0a7]
