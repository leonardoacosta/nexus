# Tasks — credential-usage-history
<!-- beads:epic:nx-qayeb -->
<!-- beads:feature:nx-yx7fl -->

## DB Batch
- [x] [1.1] Create `packages/db/src/schema/credentialPolls.ts` — `credential_polls` table mirroring `health_snapshots`: `id` integer identity PK, `credentialId` text FK → `credentials.id` (`onDelete: cascade`), `fingerprint` text notNull, `usage5hUsed`/`usage5hLimit`/`usage7dUsed`/`usage7dLimit` integer, `usage5hResetAt`/`usage7dResetAt` timestamptz nullable, `polledAt` timestamptz notNull; indexes `(credentialId, polledAt)` and `(polledAt)`. Export `credentialPolls` + inferred types. [owner:db-engineer] [beads:nx-4jqil]
- [x] [1.2] Export `credentialPolls` from `packages/db/src/schema/index.ts` and ensure it is reachable via the `@nexus/db` barrel used by the agent. [owner:db-engineer] [beads:nx-n9xve]
- [x] [1.3] Generate the migration: `pnpm --filter @nexus/db db:generate`; commit the resulting `packages/db/drizzle/00XX_*.sql`. NEVER `db:push`. [owner:db-engineer] [beads:nx-c9uld]

## API Batch
- [x] [2.1] In `apps/agent/src/services/credential-usage-poller.ts` `writeSnapshot()`, after the existing `credentials` current-state update, `INSERT` one `credential_polls` row (credentialId, fingerprint, the four used/limit values, both reset instants, `polledAt = new Date()`). Only on successful parse; no insert on failed/unparseable polls. [owner:api-engineer] [beads:nx-r4n23]
- [x] [2.2] Thread the credential `fingerprint` into `writeSnapshot` (extend `queryPollableRows`/`PrimaryAvailableRow` to select `fingerprint`) so the history row can be grouped by account. [owner:api-engineer] [beads:nx-a0pii]
- [x] [2.3] Add `credential_polls` pruning to the weekly reaper in `apps/agent/src/services/cron.ts` `runReaperJob` — delete rows where `polled_at < now() - interval '30 days'`. [owner:api-engineer] [beads:nx-3teeu]
- [x] [2.4] Add `GET /credentials/:id/usage-history?window=5h|7d&sinceHours=N` handler (new function beside `handlers-health-usage.ts`): query `credential_polls` for the id since the lookback, map the selected window's columns to `{ polledAt, used, limit }`, order `polled_at ASC`, return `{ points }`. Defaults `window=5h`, `sinceHours=24`. [owner:api-engineer] [beads:nx-5sk9s]
- [x] [2.5] Register the new route in `apps/agent/src/routes/credentials/index.ts`. [owner:api-engineer] [beads:nx-n03hd]
- [x] [2.6] Add `UsageHistoryPoint` (`{ polledAt: string; used: number; limit: number }`) to `packages/core/src/types/account.ts` and export from `packages/core/src/index.ts`. [owner:types-engineer] [beads:nx-e2q41]

## UI Batch
- [ ] [3.1] Add `UsageHistoryPoint` Codable model + `CredentialListResponse`-style envelope to `apps/swift/NexusShared/Models/CcProfile.swift` (or a sibling model file). [owner:swift-engineer] [beads:nx-bku97]
- [ ] [3.2] Add `NexusClient.fetchUsageHistory(id:window:sinceHours:)` in `apps/swift/NexusShared/Networking/NexusClient.swift` decoding `{ points }`. [owner:swift-engineer] [beads:nx-ffpi8]
- [ ] [3.3] Create `apps/swift/nexus-mac/Sources/Dashboard/CredentialsUsageHistoryChart.swift` — state-free Swift Charts `LineMark` sparkline over `[UsageHistoryPoint]` (x = `polledAt`, y = `used/limit`); omit when points empty. [owner:swift-engineer] [beads:nx-9hamt]
- [ ] [3.4] Render the chart in `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift` beneath the existing `CredentialsUsageBar`, loading history per account row on `.task`. Mac only; no iOS/watch changes. [owner:swift-engineer] [beads:nx-7v5qm]

## E2E Batch
- [ ] [4.1] Extend `apps/agent/src/services/credential-usage-poller.test.ts`: a successful `tickOnce()` inserts one `credential_polls` row with the expected values; a failed/unparseable poll inserts none. [owner:e2e-engineer] [beads:nx-haoyt]
- [ ] [4.2] Add a reaper test in the cron suite asserting rows older than 30 days are deleted and newer rows retained. [owner:e2e-engineer] [beads:nx-d0t9c]
- [ ] [4.3] Add a route test (beside `handlers-crud.test.ts`) for `GET /credentials/:id/usage-history`: ordered points for a seeded id, `{ points: [] }` + 200 for an unknown id, and `window=7d` selecting the 7-day columns. [owner:e2e-engineer] [beads:nx-pdirs]
- [ ] [4.4] Add a `CredentialsUsageHistoryChart` unit test (beside `CredentialsUsageBarTests.swift`) mapping points → utilization ratio and confirming empty-points hides the chart. [owner:swift-engineer] [beads:nx-2w15v]
