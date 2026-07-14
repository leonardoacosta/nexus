<!-- beads:epic:nx-2yy5p -->
<!-- beads:feature:nx-ybt3x -->

# Implementation Tasks

## API Batch

- [x] [2.1] Include `registryId` in `GET /projects/discovered` response by querying the `projects` table for a matching row; `null` when no registry row exists yet [owner:api-engineer] [type:api] [beads:nx-4uwok]
- [x] [2.2] Add `registryId: string | null` to the agent-side `AgentDiscoveredProject` interface [owner:api-engineer] [type:api] [beads:nx-nio52]
- [x] [2.3] Add `registryId?: string | null` to `packages/core`'s `DiscoveredProject` type [owner:types-engineer] [type:api] [beads:nx-apjib]

## UI Batch

- [ ] [3.1] Update `apps/nextjs/src/lib/agent-client.ts` to map `registryId` from the wire format through to the client-side `DiscoveredProject`, unchanged [owner:ui-engineer] [type:ui] [beads:nx-288h4]

## E2E Batch

- [ ] [4.1] Route unit test: registered project's discovery response carries its registryId; unregistered project's registryId is null [owner:e2e-engineer] [type:testing] [beads:nx-idfzy]
- [ ] [4.2] Client mapping test: registryId round-trips unchanged through agent-client.ts [owner:e2e-engineer] [type:testing] [beads:nx-hp0a7]
