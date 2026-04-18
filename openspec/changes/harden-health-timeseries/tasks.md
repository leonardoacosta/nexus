# Implementation Tasks

<!-- beads:epic:nx-m8ip -->

## DB Batch

- [ ] [1.1] [P-1] Run pnpm drizzle-kit generate in packages/db to produce migration file for health_snapshots_timestamp_idx (schema already declares the index — migration is missing) [owner:db-engineer] [beads:nx-d7eq]

## API Batch

- [ ] [2.1] [P-1] In apps/agent/src/health-collector.ts collectDocker() catch block, change logger.debug to logger.warn so Docker daemon failures are visible at default log levels [owner:api-engineer] [beads:nx-lzfb]

## E2E Batch

- [ ] [3.1] [P-1] Convert describe.skip at apps/agent/src/db/db.test.ts:230 to describe.skipIf(!process.env.POSTGRES_URL); implement 3 stub tests: insert snapshot, handle null metric fields, query time-series ordered ascending [owner:e2e-engineer] [beads:nx-n4mv]
- [ ] [3.2] [P-1] Implement 1 stub test in health-history.test.ts block 4.1 (HealthScheduler requires live PG): assert scheduler writes a snapshot on tick against POSTGRES_URL [owner:e2e-engineer] [beads:nx-kzwc]
- [ ] [3.3] [P-1] Implement 5 stub tests in health-history.test.ts block 4.2 (GET /health/history requires live PG): cover ?hours=1 response, default 24h, 400 for invalid hours, 400 for negative hours, empty array when no snapshots [owner:e2e-engineer] [beads:nx-gfmc]
- [ ] [3.4] [P-2] Run pnpm --filter @nexus/agent test POSTGRES_URL=<live-url> to verify the 9 previously-stub tests now execute and pass [owner:e2e-engineer] [beads:nx-fnak]
