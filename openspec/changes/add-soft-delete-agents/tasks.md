# Implementation Tasks

<!-- beads:epic:nx-kkwr -->

## DB Batch

- [ ] [1.1] [P-1] Add deletedAt timestamp column to packages/db/src/schema/agents.ts [owner:db-engineer] [beads:nx-n9ex]
- [ ] [1.2] [P-2] Run pnpm drizzle-kit generate to produce migration file [owner:db-engineer] [beads:nx-wr90]

## API Batch

- [ ] [2.1] [P-1] Audit agent read queries: grep for .from(agentsTable) or agent list functions to enumerate sites needing WHERE deletedAt IS NULL filter [owner:api-engineer] [beads:nx-975x]
- [ ] [2.2] [P-2] Convert apps/agent/src/routes/settings.ts:98 from db.delete to db.update setting deletedAt = new Date() [owner:api-engineer] [beads:nx-zjv5]
- [ ] [2.3] [P-2] Apply WHERE deletedAt IS NULL to agent list queries identified in 2.1 [owner:api-engineer] [beads:nx-vg7d]

## E2E Batch

- [ ] [3.1] Unit test agent delete path: assert deletedAt is set, row is NOT physically removed [owner:e2e-engineer] [beads:nx-23pb]
- [ ] [3.2] Unit test agent list query: assert soft-deleted agents are excluded by default [owner:e2e-engineer] [beads:nx-lnz0]
- [ ] [3.3] Unit test historical session join: assert a session referencing a soft-deleted agent can still resolve the agent row when explicitly querying by ID [owner:e2e-engineer] [beads:nx-qn6t]
