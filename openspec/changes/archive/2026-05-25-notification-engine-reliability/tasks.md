<!-- beads:epic:nx-jiqt9 -->
<!-- beads:feature:nx-87cw5 -->

# Tasks: notification-engine-reliability

## DB Batch

## API Batch

- [x] [1.1] Add transition guards to the meeting state machine so invalid transitions are rejected/logged, not silently accepted [owner:api-engineer] [type:api] [beads:nx-zncj]
- [x] [1.2] Add overflow protection to the notification buffer (bounded size + drop/evict policy) [owner:api-engineer] [type:api] [beads:nx-s0sg]
- [x] [1.3] Wrap external channel API awaits in `router.ts` with timeouts so a hung channel cannot stall delivery [owner:api-engineer] [type:api] [beads:nx-x39j]
- [x] [1.4] Make the routing handler surface a missing channel handler (log + capture) instead of silently skipping [owner:api-engineer] [type:api] [beads:nx-y035]

## UI Batch

## E2E Batch

- [x] [2.1] Regression tests: invalid transition rejected, buffer overflow bounded, channel-timeout fires, missing-handler surfaced [owner:e2e-engineer] [type:testing]
