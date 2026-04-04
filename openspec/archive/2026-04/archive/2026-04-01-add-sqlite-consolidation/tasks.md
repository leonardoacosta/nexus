# Implementation Tasks

<!-- beads:epic:nx-5ba -->

## Schema Migration Batch

- [ ] [1.1] [P-1] Add v3 migration to db.rs: CREATE TABLE cron_runs, git_events, agent_lifecycle with indexes [owner:engineer]
- [ ] [1.2] [P-1] Add CRUD methods for cron_runs: `insert_cron_run()`, `query_cron_runs(job, days)` [owner:engineer]
- [ ] [1.3] [P-1] Add CRUD methods for git_events: `insert_git_event()`, `query_git_events(project, days)` [owner:engineer]
- [ ] [1.4] [P-1] Add CRUD methods for agent_lifecycle: `insert_lifecycle_event()`, `query_lifecycle(days)`, `current_uptime()` [owner:engineer]
- [ ] [1.5] [P-2] Update prune_old_records() to include cron_runs, git_events, agent_lifecycle (30-day retention) [owner:engineer]
- [ ] [1.6] [P-2] Add unit tests for v3 migration, all new CRUD methods [owner:engineer]

## Cron Persistence Batch

- [ ] [2.1] [P-1] In cron.rs, after each job execution: call db.insert_cron_run() with job name, status, details JSON, metrics [owner:engineer]
- [ ] [2.2] [P-2] Remove CronLogger JSONL write logic from cron_state.rs — no more writes to cron-log.jsonl [owner:engineer]
- [ ] [2.3] [P-2] Remove JSONL rotation logic (file size check + rename) from cron_state.rs [owner:engineer]
- [ ] [2.4] [P-2] Update GET /cron HTTP endpoint to read from DB instead of JSONL [owner:engineer]

## Git Event Persistence Batch

- [ ] [3.1] [P-1] In git_watch.rs, on BranchSwitch/NewCommit/DetachedHead event: call db.insert_git_event() with project, event_type, old_ref, new_ref [owner:engineer]
- [ ] [3.2] [P-2] Pass Arc<NexusDb> to GitWatchService (update constructor + main.rs wiring) [owner:engineer]
- [ ] [3.3] [P-2] Add GET /analytics/git?project=X&days=N HTTP endpoint [owner:engineer]

## Agent Lifecycle Batch

- [ ] [4.1] [P-1] In main.rs, after DB init + migration: insert agent_lifecycle event_type="start" with version from env!("CARGO_PKG_VERSION") [owner:engineer]
- [ ] [4.2] [P-1] In shutdown coordinator, before exit: insert event_type="stop" with uptime_seconds and shutdown reason [owner:engineer]
- [ ] [4.3] [P-2] Add GET /analytics/lifecycle HTTP endpoint returning start/stop history + current uptime [owner:engineer]

## Proto + gRPC Analytical RPCs Batch

- [ ] [5.1] [P-1] Add to proto/nexus.proto: GetSessionHistory, GetFailureTrends, GetHealthTimeSeries, GetSpecVelocity RPC definitions with request/response messages [owner:engineer]
- [ ] [5.2] [P-1] Implement GetSessionHistory gRPC handler — query sessions table with days filter, return structured records [owner:engineer]
- [ ] [5.3] [P-1] Implement GetFailureTrends gRPC handler — query failures table for per-tool counts + daily trend [owner:engineer]
- [ ] [5.4] [P-1] Implement GetHealthTimeSeries gRPC handler — query health_samples table with hours filter [owner:engineer]
- [ ] [5.5] [P-1] Implement GetSpecVelocity gRPC handler — query spec_snapshots table with project + days filter [owner:engineer]
- [ ] [5.6] [P-2] Pass Arc<NexusDb> to NexusAgentService (via AgentServiceConfig) for gRPC handlers to query [owner:engineer]

## Verification Batch

- [ ] [6.1] Verify cargo build succeeds for all workspace crates (including proto regeneration) [owner:engineer]
- [ ] [6.2] Verify cargo test passes with new v3 migration, CRUD, cron, git, lifecycle tests [owner:engineer]
- [ ] [6.3] Verify cargo clippy reports no new warnings [owner:engineer]
