---
stack: t3
---
<!-- beads:epic:nx-u9x66 -->
<!-- beads:feature:nx-i7qly -->

<!-- stack: one of t3 | cc-meta | effect | dotnet — see commands/apply/references/stacks.md § "Stack vocabulary crosswalk" for the full tasks.md-stack:/--stack-profile/detect_stack() mapping -->

# Implementation Tasks

## DB Batch

- [ ] [1.1] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/agents.ts` (lastSeen, createdAt, deletedAt), `packages/db/src/schema/bloatRadar.ts` (runTimestamp), `packages/db/src/schema/ccProfileEvents.ts` (createdAt), `packages/db/src/schema/ccProfiles.ts` (createdAt, updatedAt), `packages/db/src/schema/credentialSwaps.ts` (createdAt). [beads:nx-o4apb]
- [ ] [1.2] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/credentials.ts` — leasedAt, cooldownUntil, createdAt, updatedAt only; leave the already-`withTimezone` columns (expiresAt, usage5hResetAt, usage7dResetAt, usagePolledAt) untouched. [beads:nx-7b5on]
- [ ] [1.3] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/cronRuns.ts` (timestamp), `packages/db/src/schema/elevenlabsCredentials.ts` (lastTestOkAt, createdAt, updatedAt), `packages/db/src/schema/fleetPresence.ts` (heartbeat, updatedAt), `packages/db/src/schema/healthSnapshots.ts` (timestamp). [beads:nx-e06qz]
- [ ] [1.4] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/hookSchemaFingerprints.ts` (firstSeen, lastSeen), `packages/db/src/schema/integrationCredentials.ts` (lastTestOkAt, createdAt, updatedAt), `packages/db/src/schema/notificationSettings.ts` (updatedAt), `packages/db/src/schema/notifications.ts` (createdAt, sentAt). [beads:nx-35ab7]
- [ ] [1.5] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/presenceHolds.ts` (holdUntil, createdAt, releasedAt), `packages/db/src/schema/processWatcherState.ts` (observedAt), `packages/db/src/schema/projectLocations.ts` (lastDiscoveredAt, createdAt), `packages/db/src/schema/projects.ts` (discoveredAt, updatedAt). [beads:nx-9xl73]
- [ ] [1.6] Convert bare `timestamp()` columns to `{mode:'date',withTimezone:true}` in `packages/db/src/schema/routingRules.ts` (updatedAt), `packages/db/src/schema/scriptErrors.ts` (createdAt), `packages/db/src/schema/sessionEvents.ts` (timestamp), `packages/db/src/schema/sessions.ts` (startedAt, lastActivity, endedAt, rateLimitResetAt, idleSince). [beads:nx-cge38]
- [ ] [1.7] Run `pnpm --filter @nexus/db db:generate`; confirm exactly ONE new migration file lands under `packages/db/drizzle/`; inspect its SQL for `ALTER COLUMN ... SET DATA TYPE timestamp with time zone` with no value-shifting `USING` clause before committing it. [beads:nx-aqz57]
  - depends on: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
- [ ] [1.8] Apply the generated `packages/db/drizzle/` migration via `pnpm --filter @nexus/db db:migrate` against a throwaway/local Postgres (NEVER the shared homelab `localhost:5436` `nexus` DB — nx-vtzmd); confirm clean apply and all 43 columns now report `timestamp with time zone`. [beads:nx-1ncns]
  - depends on: 1.7
- [ ] [1.9] Extend `packages/db/src/migrate.test.ts` (POSTGRES_URL-gated pattern already present) with a round-trip test: insert a session row with `startedAt`/`lastActivity`/`endedAt`, apply the migration, re-read via drizzle `mode:'date'`, assert the JS `Date` values are byte-identical pre/post; run `bun test` with `NEXUS_PG_TESTS`/`POSTGRES_URL` set and paste passing output. [beads:nx-fb3fs]
  - depends on: 1.8
