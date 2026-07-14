## MODIFIED Requirements

### Requirement: Scheduler Captures All Disks On Multi-Disk Systems

`HealthScheduler` MUST capture every disk's data on multi-disk systems instead of dropping data by reading only a single disk entry, and every other health-reporting call site aggregating multi-disk percentage MUST call the same shared `aggregateDiskPercent()` helper rather than re-implementing the aggregation inline.

#### Scenario: Multi-disk system reports all disks

- **WHEN** `apps/agent/src/health-scheduler.ts` processes metrics on a host with more than one disk
- **THEN** all disks are captured in the recorded snapshot, not just `disk[0]`, so no mount is silently lost

#### Scenario: server-health-handler.ts uses the shared aggregation helper, not a stale duplicate

- **GIVEN** `apps/agent/src/server-health-handler.ts` computes an aggregate disk percentage for
  its response
- **AND** all reported disks have `total_bytes = 0` (the case the unweighted-average fallback
  in `aggregateDiskPercent()` handles)
- **WHEN** the handler builds its response
- **THEN** it calls the shared `aggregateDiskPercent()` helper (imported from the same module
  `health-scheduler.ts` uses) and returns its result
- **AND** it does NOT fall back to `metrics.disk[0]?.percent ?? null`
