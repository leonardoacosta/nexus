# Implementation Tasks

<!-- beads:epic:nx-dj2 -->

## Schema Migration Batch

- [ ] [1.1] [P-1] Add v2 migration to `db.rs`: CREATE TABLE health_samples, spec_snapshots, credential_polls, credential_swaps, notifications with indexes [owner:engineer]
- [ ] [1.2] [P-1] Add CRUD methods for health_samples: `insert_health_sample()`, `query_health_samples(hours)` [owner:engineer]
- [ ] [1.3] [P-1] Add CRUD methods for spec_snapshots: `insert_spec_snapshot()`, `query_spec_velocity(project, spec, days)` [owner:engineer]
- [ ] [1.4] [P-1] Add CRUD methods for credential_polls: `insert_credential_poll()`, `query_credential_history(account, hours)`, `latest_credential_polls()` [owner:engineer]
- [ ] [1.5] [P-1] Add CRUD methods for credential_swaps: `insert_credential_swap()`, `query_credential_swaps(hours)` [owner:engineer]
- [ ] [1.6] [P-1] Add CRUD methods for notifications: `insert_notification()`, `query_notifications(hours, type_filter, project_filter)` [owner:engineer]
- [ ] [1.7] [P-2] Update `prune_old_records()` to include all 5 new tables (30-day retention) [owner:engineer]
- [ ] [1.8] [P-2] Add unit tests for v2 migration, all new CRUD methods, and retention cleanup [owner:engineer]

## Health Sampling Batch

- [ ] [2.1] [P-1] In `health.rs`, add 30-second sampling timer: every 6th refresh (5s * 6 = 30s), write current MachineHealth to `db.insert_health_sample()` [owner:engineer]
- [ ] [2.2] [P-2] Pass `Arc<NexusDb>` to HealthCollector (update constructor + main.rs wiring) [owner:engineer]

## Spec Timeseries Batch

- [ ] [3.1] [P-1] In `spec_watcher.rs`, after processing each project's specs: if tasks_done changed from previous DB value, insert a spec_snapshot row [owner:engineer]
- [ ] [3.2] [P-2] Add dedup: only insert snapshot if (project, spec, completed_tasks) differs from the latest row for that spec [owner:engineer]

## Credential Analytics Batch

- [ ] [4.1] [P-1] In `credential_pool.rs`, after each usage poll: write per-account results to `db.insert_credential_poll()` instead of (or in addition to) UsageCache JSON [owner:engineer]
- [ ] [4.2] [P-1] In `rate_limit_interceptor.rs`, after successful swap: write to `db.insert_credential_swap()` with from_account, to_account, trigger session_id [owner:engineer]
- [ ] [4.3] [P-2] On startup, load latest credential polls from DB instead of usage-cache.json for initial account usage data [owner:engineer]
- [ ] [4.4] [P-2] Remove usage-cache.json write logic from credential_pool.rs (DB is now source of truth) [owner:engineer]

## Notification Store Batch

- [ ] [5.1] [P-1] In receiver service delivery path, after sending notification: write to `db.insert_notification()` with message, type, project, channels, delivered status [owner:engineer]
- [ ] [5.2] [P-2] In suppression check path, log suppressed notifications with delivered=false, suppressed=true [owner:engineer]
- [ ] [5.3] [P-2] Pass `Arc<NexusDb>` to ReceiverService (update constructor + main.rs wiring) [owner:engineer]

## HTTP Analytics Endpoints Batch

- [ ] [6.1] [P-1] Add `GET /analytics/health?hours=N` endpoint returning health_samples data [owner:engineer]
- [ ] [6.2] [P-1] Add `GET /analytics/specs?project=X&days=N` endpoint returning spec_snapshots for velocity analysis [owner:engineer]
- [ ] [6.3] [P-1] Add `GET /analytics/credentials?hours=N` endpoint returning credential_polls + recent swaps [owner:engineer]
- [ ] [6.4] [P-2] Register all 3 routes in main.rs [owner:engineer]

## MCP Tools Batch

- [ ] [7.1] [P-1] Add `get_health_history` tool to nexus-mcp — proxies GET /analytics/health [owner:engineer]
- [ ] [7.2] [P-1] Add `get_credential_history` tool to nexus-mcp — proxies GET /analytics/credentials [owner:engineer]

## Verification Batch

- [ ] [8.1] Verify `cargo build` succeeds for all workspace crates [owner:engineer]
- [ ] [8.2] Verify `cargo test` passes with new migration, CRUD, and analytics tests [owner:engineer]
- [ ] [8.3] Verify `cargo clippy` reports no new warnings [owner:engineer]
