<!-- beads:epic:nx-tyq0n -->
<!-- beads:feature:nx-iijxw -->

# Implementation Tasks

## DB Batch

- [ ] create process_watcher_state table schema
- [ ] migration

## API Batch

- [ ] expose lastTickMs/getters on process-watcher service
- [ ] /health/process-watcher route
- [ ] /metrics counters and histogram
- [ ] dispatcher emits ProcessWatcherStalled on tick lag

## E2E Batch

- [ ] health endpoint returns expected shape after watcher tick
- [ ] alert fires when watcher killed/stalled
