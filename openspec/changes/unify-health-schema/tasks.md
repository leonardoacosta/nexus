## 1. TS Agent — Ingest Endpoint
- [x] 1.1 Add `POST /health/ingest` route to the TS agent HTTP server that accepts a `HealthMetrics` JSON body and calls `insertHealthSnapshot`
- [x] 1.2 Validate the ingest request body; return 400 on schema mismatch

## 2. Rust — Remove SQLite writer, add HTTP POST
- [x] 2.1 Remove the `db_sample_counter` loop and `insert_health_sample` call from `crates/nexus-agent/src/health.rs:122-153`
- [x] 2.2 Add a `reqwest` (or `ureq`) HTTP POST call to `http://127.0.0.1:7400/health/ingest` with the current snapshot serialised as JSON
- [x] 2.3 Apply exponential backoff with jitter (base 1 s, max 60 s, 3 attempts) to the HTTP POST retry loop in Rust
- [x] 2.4 Remove `HealthSampleRecord` struct and any remaining SQLite health write code from `health.rs`

## 3. SQLite — Drop health_samples table
- [x] 3.1 Write a SQLite migration (or inline schema update) that drops the `health_samples` table
- [x] 3.2 Remove `insert_health_sample` from the Rust `Db` impl and any imports that become dead code

## 4. TS Agent — Disk Aggregation Fix
- [x] 4.1 Replace `disk[0]?.percent` with a weighted-average disk percent across all mounts in `apps/agent/src/health-scheduler.ts:49-50`
- [x] 4.2 Ensure `rawJson` still captures the full `metrics.disk` array (already true; verify no regression)

## 5. TS Agent — Exponential Backoff
- [x] 5.1 Replace the fixed 2-second `setTimeout` retry in `apps/agent/src/health-scheduler.ts:65` with exponential backoff (base 1 s, max 60 s, 3 attempts, uniform jitter)
- [x] 5.2 Emit `logger.error` on final retry failure (currently already done; confirm log level)

## 6. HealthMetrics — collectedAt field
- [x] 6.1 Add `collectedAt: string` (ISO-8601) to the `HealthMetrics` type in `packages/core/src/types` (or equivalent)
- [x] 6.2 Populate `collectedAt` with `new Date().toISOString()` at the end of a successful `collect()` call in `apps/agent/src/health-collector.ts`

## 7. Next.js — Stale Indicator
- [x] 7.1 In `apps/nextjs/src/components/HealthPoller.tsx`, read `collectedAt` from each metric entry
- [x] 7.2 Display a visible stale warning badge on `MachineCard` when `Date.now() - new Date(collectedAt).getTime() > 30_000`

## 8. Logging — Pino context
- [x] 8.1 Add structured Pino log fields (`hostname`, `intervalMs`) to the `tick()` method in `apps/agent/src/health-collector.ts`
- [x] 8.2 Add structured Pino log fields (`hostname`, `diskPercent`, `cpuPercent`) to the `tick()` method in `apps/agent/src/health-scheduler.ts`

## 9. Tests
- [x] 9.1 Unit test: TS health-scheduler disk weighted-average calculation
- [x] 9.2 Unit test: exponential backoff helper returns delays within [base, max] bounds
- [x] 9.3 Integration test: `POST /health/ingest` persists a row to `health_snapshots`
- [ ] 9.4 Integration test: Rust health.rs POSTs to `/health/ingest` on the next 30-second cycle (mock HTTP server)

## 10. Quality Gates
- [x] 10.1 `cargo clippy -- -D warnings` passes with no new warnings
- [x] 10.2 `cargo test` passes
- [x] 10.3 `pnpm typecheck` passes across all workspaces
- [x] 10.4 `pnpm lint` passes
