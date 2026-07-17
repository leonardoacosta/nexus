---
stack: t3
---
<!-- beads:epic:nx-qayeb -->
<!-- beads:feature:nx-x2ixd -->

# Implementation Tasks

## DB Batch

(none — no schema changes)

## API Batch

- [x] [1.1] [P-1] Extract exported pure `computeNextIntervalMs({ maxFiveHourUtilization, backoff, intervalMs, hotIntervalMs })` in `apps/agent/src/services/credential-usage-poller.ts`; add `HOT_THRESHOLD_PCT = 80`, `DEFAULT_HOT_INTERVAL_MS = 60_000`, `NEXUS_USAGE_POLL_HOT_INTERVAL_MS` env override; selection order backoff > hot > default [owner:api-engineer] [beads:nx-xhsrh]
- [x] [1.2] [P-1] Wire the tick loop to compute max 5-hour utilization from the just-parsed poll results (exclude null/zero-limit rows) and pass it to `computeNextIntervalMs` when rescheduling [owner:api-engineer] [beads:nx-fv4h7]
- [x] [1.3] [P-2] Unit tests in `apps/agent/src/services/credential-usage-poller.test.ts`: selection table (backoff wins; hot at exactly 80; default at 79.9; env override for hot interval; null/zero-limit exclusion) plus an integration-style tick test asserting the rescheduled delay is hot after a >=80 parse [owner:api-engineer] [beads:nx-02c0l]

## UI Batch

(none)

## E2E Batch

(none — consumer-visible effect ships with the cross-repo cc-tmux bead)
