<!-- beads:epic:nx-68ssl -->
<!-- beads:feature:nx-plkfw -->

# Tasks: health-monitoring-observability

## DB Batch

- [x] [1.1] Add a timestamp index on `healthSnapshots` (`packages/db/src/schema/healthSnapshots.ts` + generated migration under `packages/db/drizzle`) for fast time-series queries [owner:db-engineer] [type:db] [beads:nx-lzdu]

## API Batch

- [x] [2.1] Add structured logging to `HealthCollector` (`apps/agent/src/health-collector.ts`) via `createLogger` so collection errors are surfaced, not swallowed [owner:api-engineer] [type:api] [beads:nx-qcrz]
- [x] [2.2] Fix `HealthScheduler` (`apps/agent/src/health-scheduler.ts`) to capture all disks instead of only `disk[0]` [owner:api-engineer] [type:api] [beads:nx-k7xa]

## E2E Batch

- [x] [3.1] Regression tests: timestamp index present + used; collector logs on error; multi-disk capture [owner:e2e-engineer] [type:testing]
