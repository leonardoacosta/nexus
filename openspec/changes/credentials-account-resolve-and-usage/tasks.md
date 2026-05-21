# Tasks: credentials-account-resolve-and-usage

<!-- beads:epic:nx-hnkty -->
<!-- beads:feature:nx-lmfg7 -->

## DB Batch

- [x] 1.1 Extend `packages/db/src/schema/credentials.ts` with seven nullable columns: `usage5hUsed` (integer), `usage5hLimit` (integer), `usage5hResetAt` (timestamptz), `usage7dUsed` (integer), `usage7dLimit` (integer), `usage7dResetAt` (timestamptz), `usagePolledAt` (timestamptz). All default NULL. Snake_case wire-format names: `usage_5h_used`, etc. [beads:nx-5y8kv]
- [x] 1.2 Generate `packages/db/drizzle/0034_add_credential_usage_columns.sql` via drizzle-kit (worktree 0034 slot was open; spec text said 0035, but the active baseline is 0033 so drizzle-kit emitted 0034). Trim auto-emitted SQL to only the seven ALTER TABLE statements; keep the full snapshot for future drizzle-kit baselines (same convention as 0033/0034). [beads:nx-xkc1z]
- [x] 1.3 Confirm the new columns surface in `packages/db/src/index.ts` re-exports automatically via the existing `type Credential = typeof credentials.$inferSelect` synthesis. [beads:nx-d0og4]

## API Batch

- [ ] 2.1 Add `apps/agent/src/services/credential-usage-poller.ts` exporting `startCredentialUsagePoller({ db, pool })`. Wakes every `NEXUS_USAGE_POLL_INTERVAL_MS || 5*60*1000` ms. On tick: query `is_primary=true AND status='available'` credentials, decrypt access tokens via pool, fan out 4-concurrent `/api/oauth/usage` calls (10s timeout each), parse `{ five_hour: {used, limit, resets_at}, seven_day: {...} }` defensively (Zod or hand-rolled), update each credential row's seven columns + `usagePolledAt`. Errors counted, never throw. Back-off to 30min next tick when >50% of calls failed. [beads:nx-miz5g]
- [ ] 2.2 Wire the poller into `apps/agent/src/index.ts` startup (after pool init, with cleanup on shutdown). Mirror the pattern of `cron.ts startCronService` registration. [beads:nx-wge4z]
- [ ] 2.3 Add `apps/agent/src/services/credential-usage-poller.test.ts` covering: successful poll updates row, non-primary skipped, API failure preserves existing data, back-off triggers at >50% failure, back-off resets on next success. Use real PG scratch schema + mocked fetch (via `vi.spyOn(global, "fetch")` or equivalent Bun-native pattern). [beads:nx-1fp18]
- [ ] 2.4 Make `apps/agent/src/credentials/pool/pool-core.ts probeIdentity` public (or expose via a `pool.refreshIdentity(id): Promise<IdentityResult>` wrapper). Preserve existing private-call usage from `add()`. [beads:nx-q2h2a]
- [ ] 2.5 Add `apps/agent/src/routes/credentials/handlers-refresh-identity.ts` with two handlers: `handleRefreshIdentity(id)` (single) and `handleRefreshIdentityAll()` (every credential where `account_email IS NULL`). Both decrypt, call `/api/oauth/profile`, update row, return JSON. Single returns the new identity object; all returns `{ probed, succeeded, failed }` summary. [beads:nx-jclg7]
- [ ] 2.6 Register the two new routes in `apps/agent/src/routes/credentials/index.ts` (and the router config in `apps/agent/src/server-request-handler.ts` if not auto-dispatched). Routes must be registered BEFORE the `/credentials/:id` catch-all for single-credential GET/DELETE. [beads:nx-bv41q]
- [ ] 2.7 Add unit tests for both refresh-identity handlers covering: blank-row populates, populated-row overwrites, 401 returns 502 with error, all-endpoint skips non-blank rows. Mock the fetch to `/api/oauth/profile`. [beads:nx-4x74v]
- [ ] 2.8 Extend `apps/agent/src/routes/credentials/handlers-crud.ts handleListCredentials` to accept `?dedupe=true` param. When true, post-filter the enriched list to `is_primary === true`, compute per-primary `siblingCount` + `siblingIds[]` by indexing the full list by `duplicateGroupId`. When false/absent, return today's exact shape. [beads:nx-sseby]
- [ ] 2.9 Extend `handleListCredentials` enrichment to always include the seven usage fields (`usage5hUsed`, `usage5hLimit`, `usage5hResetAt`, etc.) on every row. Null when poller hasn't sampled. Field names use camelCase wire output. [beads:nx-ywipi]
- [ ] 2.10 Extend `apps/agent/src/routes/credentials/handlers-crud.test.ts` with dedupe scenarios (3-row group collapses to 1, no-dupe rows have siblingCount 0, default behavior unchanged byte-for-byte) and usage-field passthrough (rows with usage data carry the fields; rows without get nulls). [beads:nx-06eve]

## UI Batch

- [ ] 3.1 Extend `apps/swift/NexusShared/Models/CcProfile.swift` with optional `usage5hUsed: Int?`, `usage5hLimit: Int?`, `usage5hResetAt: Date?`, plus 7d equivalents, plus `usagePolledAt: Date?`, plus `siblingCount: Int?`, `siblingIds: [String]?`. ISO-8601 date decode via existing strategy. All optional for back-compat. [beads:nx-7n6yv]
- [ ] 3.2 Extend `apps/swift/NexusShared/Networking/NexusClient.swift` with `refreshCredentialIdentity(id:)` (POST) and `refreshAllCredentialIdentities()` (POST). Pass `?dedupe=true` through `fetchCredentials(dedupe:)`. Add same to `NexusAggregateClient.swift` via existing fan-out. **Conflict: shared file with 4 prior specs; wave-plan-build serializes.** [beads:nx-wpc7p]
- [ ] 3.3 Add `apps/swift/nexus-mac/Sources/Dashboard/CredentialsUsageBar.swift` — reusable `View` taking `(used: Int, limit: Int, resetAt: Date?, label: String)`. Renders `GeometryReader`-based bar with green/yellow/red zones at 70%/90%, caption beneath, `TimelineView`-driven countdown beside. [beads:nx-a2gyy]
- [ ] 3.4 Modify `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift` row builder to include two stacked `CredentialsUsageBar` (5h on top, 7d below) when both `usage5hLimit != nil` AND `usage7dLimit != nil`. Hide block entirely otherwise. [beads:nx-3gk31]
- [ ] 3.5 Add a refresh-identity button to each row in CredentialsView where `accountEmail == nil`. Use SF Symbol `arrow.clockwise.circle`. Tap → `NexusClient.refreshCredentialIdentity(id:)` → optimistic identity update. On error, show red dot for 2s then revert via `@State private var refreshError: [String: Date]` keyed by id. [beads:nx-qx23j]
- [ ] 3.6 Add a "Dedupe" toggle to the CredentialsView header (right side of the existing controls). Default ON via `@AppStorage("credentials.dedupe", store: ...)` default true. On change, refetch with the new param. [beads:nx-k10qi]
- [ ] 3.7 Render `+N duplicates` chip on each row when `siblingCount > 0`. Tap → expand inline showing `siblingIds[]` each with a delete button. Use a `@State private var expandedSiblings: Set<String>` for per-row expand state. [beads:nx-vk2hy]
- [ ] 3.8 Add `apps/swift/nexus-mac/Sources/Dashboard/CredentialsUsageBarTests.swift` covering: 20%/70%/90% color thresholds, countdown text formatting at >1h / <1h / past-due, nil-limit hides bar. [beads:nx-mj3ih]
- [ ] 3.9 Add `apps/swift/nexus-mac/Sources/Dashboard/CredentialsViewTests.swift` covering: dedupe-toggle round-trip with @AppStorage, refresh-identity button visibility logic, error-dot timeout, sibling expand state. [beads:nx-5mds1]

## E2E Batch

- [ ] 4.1 End-to-end: deploy agent with the poller, wait two ticks, curl `GET /credentials`, assert at least one row has non-null `usage5hUsed` and `usagePolledAt`. Confirm `usage_5h_reset_at` is a valid ISO timestamp in the future. [beads:nx-7cqem]
- [ ] 4.2 End-to-end: with one credential having `account_email = null` in the DB, curl `POST /credentials/:id/refresh-identity`. Assert response 200 with populated identity. Re-query GET /credentials, assert the row now carries the email. [beads:nx-53zr7]
- [ ] 4.3 End-to-end: curl `GET /credentials?dedupe=true` against a homelab agent with known-duplicate credentials. Assert response has fewer rows than `GET /credentials`, and each primary row has `siblingCount` set. [beads:nx-weu5y]
- [ ] 4.4 [user] Open Nexus.app Credentials tab. Confirm: (a) usage bars render with reset countdowns; (b) refresh-identity button works on a row with blank email; (c) dedupe toggle collapses/expands the list; (d) sibling chip expansion shows duplicate ids. [beads:nx-47gn6]
