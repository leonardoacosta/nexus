# Proposal: Harden Health Timeseries

## Change ID
`harden-health-timeseries`

## Summary
Add timestamp index to healthSnapshots schema, elevate Docker-failure logging from debug to warn in HealthCollector, and implement the 9 skipped/stubbed PG integration tests for health persistence. Closes nx-lzdu, nx-qcrz, nx-it4u, nx-3awz.

**Investigation finding (2026-04-17):** `packages/db/src/schema/healthSnapshots.ts` already declares `timestampIdx` (line 19) via `index("health_snapshots_timestamp_idx").on(table.timestamp)`. No schema change is needed — but no matching migration file exists in `packages/db/src/migrations/`. The DB batch task is to generate the migration so the index is applied to existing deployments.

**Investigation finding (2026-04-17):** `apps/agent/src/health-collector.ts` already imports `logger` from `@nexus/core/node` and already logs in `tick()` at `warn` level on collection failure. The real gap is `collectDocker()` catch: it logs at `debug` level (`logger.debug`), making Docker daemon failures invisible at default log levels. The fix is narrowly targeted: promote `collectDocker` catch to `logger.warn` with backoff context.

**Investigation finding (2026-04-17):** Stub count is 9, not 5. `apps/agent/src/db/db.test.ts:230` has 3 stub tests under `describe.skip("health snapshots (requires live PG)")`. `apps/agent/src/routes/health-history.test.ts` has 6 stub tests across two `describe.skipIf(!POSTGRES_URL)` blocks (1 + 5).

## Context
- Extends: `openspec/specs/health-timeseries/spec.md`
- Audit findings addressed: nx-lzdu (no timestamp index), nx-qcrz (silent Docker errors), nx-it4u (skipped PG tests), nx-3awz (stub placeholders in test files)

## Motivation

Three small TS-era health findings from prior audits bundle naturally: same subsystem (health persistence pipeline), same migration phase pending. Each finding is low-effort in isolation; bundling avoids three separate micro-PRs with identical reviewer context.

1. **Index (nx-lzdu):** The schema already declares the index in Drizzle, but no migration file exists — so existing deployments lack the index. When the `health_snapshots` table exceeds ~100k rows (a few days of 30-second sampling across multiple agents) any `WHERE timestamp BETWEEN x AND y` query becomes a sequential scan. Generating the migration closes this silently-growing risk before it becomes a P1.

2. **Logging (nx-qcrz):** `collectDocker()` swallows Docker daemon failures at `debug` level. In a default deployment `RUST_LOG=info` (or the Bun equivalent), these failures produce no observable output. An operator whose Docker daemon is misconfigured has no log signal to act on. Promoting to `warn` with backoff context is a one-line fix with high observability payoff.

3. **Tests (nx-it4u + nx-3awz):** 9 tests across three `describe` blocks contain `expect(true).toBe(true)` placeholders. These blocks are either `describe.skip` or `describe.skipIf(!POSTGRES_URL)`, so they never fail — they just silently do nothing. Implementing real assertions proves the persistence layer actually works and prevents regression when schema or query logic changes.

## Requirements

### Requirement: Timestamp index migration for healthSnapshots
The `healthSnapshots` schema already declares `index("health_snapshots_timestamp_idx").on(table.timestamp)` in Drizzle. A migration file MUST be generated via `pnpm drizzle-kit generate` so the index is applied to existing deployment databases. The generated migration MUST create the index with the name `health_snapshots_timestamp_idx` matching the schema declaration.

#### Scenario: Query at 100k+ rows
- **GIVEN** a healthSnapshots table with >100k rows
- **WHEN** a caller issues `SELECT ... WHERE timestamp BETWEEN x AND y`
- **THEN** Postgres EXPLAIN shows an index scan, not a sequential scan

### Requirement: Structured warn logging for Docker collection failures in HealthCollector
The `collectDocker()` catch block in `apps/agent/src/health-collector.ts` currently logs at `debug` level. It MUST be promoted to `warn` level so Docker daemon failures are visible at default log levels. The log entry MUST include `{ err, nextCheckMs: this.dockerBackoffMs }` context identifying the backoff duration.

#### Scenario: Docker daemon unavailable
- **GIVEN** Docker is not running on the host
- **WHEN** HealthCollector runs its next collection cycle
- **THEN** a log entry at WARN level is emitted naming the failure and the next retry time, not a silent debug entry

### Requirement: Real PG integration coverage for health persistence
The 9 stubbed integration tests for health persistence (3 in `apps/agent/src/db/db.test.ts:230` under `describe.skip`, 6 in `apps/agent/src/routes/health-history.test.ts` across two `describe.skipIf(!POSTGRES_URL)` blocks) MUST be replaced with real assertions that run against a live POSTGRES_URL. Tests MUST retain their existing skip guard so they are skipped in CI environments without PG.

Coverage required:
- Insert + query round-trip (db.test.ts)
- Null metric fields handled gracefully (db.test.ts)
- Time-series query ordered ascending within window (db.test.ts)
- Scheduler writes snapshot on tick (health-history.test.ts, block 4.1)
- GET /health/history returns data for ?hours=1 (health-history.test.ts, block 4.2)
- Defaults to 24 hours when no hours param (health-history.test.ts, block 4.2)
- Returns 400 for invalid hours param (health-history.test.ts, block 4.2)
- Returns 400 for negative hours (health-history.test.ts, block 4.2)
- Returns empty array when no snapshots exist (health-history.test.ts, block 4.2)

#### Scenario: POSTGRES_URL is set in CI
- **GIVEN** a CI environment with POSTGRES_URL set
- **WHEN** `pnpm --filter @nexus/agent test` runs
- **THEN** the previously-stubbed tests execute real inserts and queries against PG and pass

## Scope

**IN:**
- Generating the drizzle-kit migration for `health_snapshots_timestamp_idx`
- Promoting `collectDocker()` catch from `logger.debug` to `logger.warn` in `health-collector.ts`
- Replacing 9 `expect(true).toBe(true)` stubs with real assertions in `db.test.ts` and `health-history.test.ts`

**OUT:**
- Changing the schema shape (no new columns or tables)
- Changing the collection interval or retention policy
- Refactoring HealthCollector structure or public API
- Adding the index to other tables
- Changes to `tick()` logging (already at `warn` level — no gap)

## Impact

| Area | Change |
|------|--------|
| `packages/db/src/schema/healthSnapshots.ts` | No change — index already declared |
| `packages/db/src/migrations/**` | NEW migration file generated by drizzle-kit |
| `apps/agent/src/health-collector.ts` | One-line change: `logger.debug` → `logger.warn` in `collectDocker()` catch |
| `apps/agent/src/db/db.test.ts` | Replace 3 stub tests at line 230 with real PG assertions |
| `apps/agent/src/routes/health-history.test.ts` | Replace 6 stub tests (across 2 blocks) with real PG assertions |

## Risks

| Risk | Mitigation |
|------|-----------|
| Index creation on large existing table may lock | Postgres `CREATE INDEX CONCURRENTLY` avoids table lock; if drizzle-kit migration doesn't emit CONCURRENTLY, document the lock window and recommend running during low-traffic window |
| Tests assume specific schema shape | Tests colocated with the module; schema changes break tests visibly rather than silently — this is the intended behavior |
| `describe.skip` block at db.test.ts:230 must change to `describe.skipIf(!POSTGRES_URL)` | Convert the skip guard to match the existing pattern in health-history.test.ts so the tests run when POSTGRES_URL is available |
