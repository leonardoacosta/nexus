## DB Batch — Schema & Migration

- [ ] 1.1 Add `index("health_snapshots_timestamp_idx").on(healthSnapshots.timestamp)` to `packages/db/src/schema/healthSnapshots.ts`
- [ ] 1.2 Run `drizzle-kit generate` to produce the migration file for the new index
- [ ] 1.3 Verify migration file exists and references `health_snapshots_timestamp_idx`

## API Batch — Type Alignment & Error Logging

- [ ] 2.1 Rewrite `crates/nexus-core/src/health.rs` `MachineHealth` struct to match `HealthMetrics` shape: `hostname` (String), `uptime_seconds` (u64), `cpu` sub-struct (overall_percent f32 + per_core_percent Vec<f32> + load_average [f32; 3]), `ram` sub-struct (total_bytes u64, used_bytes u64, percent f32), `disk` Vec of mount/total_bytes/used_bytes/percent, `docker` Option with containers/running counts
- [ ] 2.2 Update `build_health_from_system` in `crates/nexus-agent/src/health.rs` to populate the new struct fields (byte-based RAM/disk, per-core CPU, hostname, multi-disk array)
- [ ] 2.3 Add `tracing::warn!` in `detect_docker_containers()` (health.rs:216) when `output.ok()` returns `None` or `!output.status.success()`
- [ ] 2.4 Update `HealthSampleRecord` inserts in `crates/nexus-agent/src/health.rs` (health.rs:137-139) to align with the new struct fields; add a single retry with 1-second sleep on `Err`
- [ ] 2.5 Import `logger` from `@nexus/core` in `apps/agent/src/health-collector.ts`
- [ ] 2.6 Replace the empty catch block in `HealthCollector.tick()` (`health-collector.ts:85-87`) with `logger.warn({ err }, "health collection tick failed")`
- [ ] 2.7 Add `logger.warn({ err }, "docker collection failed")` in `HealthCollector.collectDocker()` catch block (`health-collector.ts:99-102`) before returning `null`
- [ ] 2.8 Add retry logic to `HealthScheduler.tick()` (`health-scheduler.ts:45-64`): on `insertHealthSnapshot` failure, wait 2 s and retry once; log `logger.error` on second failure
- [ ] 2.9 Replace hardcoded `HEALTH_RETENTION_DAYS = 30` in `apps/agent/src/db/retention.ts:6` with `Number(process.env.HEALTH_RETENTION_DAYS ?? "30")`

## E2E Batch — Integration Tests

- [ ] 3.1 Locate and un-skip the 5 skipped tests in `health-history.test.ts` (lines 14-42) that cover DB persistence of health snapshots
- [ ] 3.2 Verify un-skipped tests pass against a live PostgreSQL instance (or test container)
- [ ] 3.3 Fix any test failures caused directly by the schema or type changes in this change (file separate issues for unrelated failures)
