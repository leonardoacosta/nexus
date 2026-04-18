# Implementation Tasks

<!-- beads:epic:nx-23yz -->

## DB Batch

- [x] [1.1] [P-1] Audit packages/db Session/CredentialRow $inferSelect shapes; document delta vs domain types in design notes [owner:db-engineer] [beads:nx-n0l1]

## API Batch

- [x] [2.1] [P-1] Refactor packages/core/src/types/session.ts: derive base Session from @nexus/db Pick/Omit; add computed fields (lastHeartbeat, command, agent, rateLimitType) as separate SessionRuntimeFields type [owner:types-engineer] [beads:nx-49du]
- [x] [2.2] [P-1] Move WireCredentialRow declaration from apps/nextjs/src/app/actions/credentials.ts:16 into packages/core/src/types/account.ts [owner:types-engineer] [beads:nx-04em]
- [x] [2.3] [P-2] Replace mapper at apps/nextjs/src/app/actions/sessions.ts:74-99 with computeSessionRuntimeFields helper; remove `as Session["status"]` and `as Session["sessionType"]` casts [owner:api-engineer] [beads:nx-wa7x]
- [x] [2.4] [P-2] Update all ~30 import sites of Session from @nexus/core to use new shape [owner:api-engineer] [beads:nx-arr5]

## UI Batch

- [x] [3.1] [P-1] Verify dashboard session components compile against new Session shape [owner:ui-engineer] [beads:nx-q2xi]

## E2E Batch

- [x] [4.1] Add unit test asserting domain Session keys are subset/superset relationship with DB row keys [owner:e2e-engineer] [beads:nx-wuq5]
- [x] [4.2] Add unit test that fails if a status enum value exists in DB but not in TS union (or vice versa) [owner:e2e-engineer] [beads:nx-tqrj]
