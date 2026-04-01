# Proposal: SQLite Phase 3 — Consolidation

## Change ID
`add-sqlite-consolidation`

## Summary
Final phase of the SQLite rollout: add 3 remaining tables (cron_runs, git_events, agent_lifecycle),
eliminate JSON/JSONL state files, and add gRPC analytical RPCs so the TUI can query historical
data from any agent without HTTP.

## Context
- Extends: `crates/nexus-core/src/db.rs` (v3 migration), `crates/nexus-agent/src/cron.rs` + `cron_state.rs`, `crates/nexus-agent/src/services/git_watch.rs`, `crates/nexus-agent/src/main.rs`, `proto/nexus.proto`, `crates/nexus-agent/src/grpc/`
- Related: `add-sqlite-store` (Phase 1 — completed), `add-sqlite-analytics` (Phase 2 — completed)

## Motivation
Phases 1-2 established 9 SQLite tables covering governance, sessions, failures, events, and
analytics. Phase 3 completes the migration by replacing the last JSON/JSONL files with DB tables
and adding gRPC analytical RPCs — enabling the TUI to query historical data from any agent in the
fleet without falling back to HTTP. This completes the vision: nexus.db as the single source of
truth for all agent state.

## Requirements

### Req-1: Cron run persistence
The cron service MUST write job execution results to the `cron_runs` table, replacing
`cron-log.jsonl` and its rotation logic.

### Req-2: Git event persistence
The git watch service MUST write branch switch, new commit, and detached head events to the
`git_events` table, replacing fire-and-forget tracing logs.

### Req-3: Agent lifecycle tracking
The agent MUST record start/stop events with version, uptime, and shutdown reason to the
`agent_lifecycle` table.

### Req-4: gRPC analytical RPCs
The agent MUST expose `GetSessionHistory`, `GetFailureTrends`, `GetHealthTimeSeries`, and
`GetSpecVelocity` gRPC RPCs backed by SQLite queries, enabling the TUI to query any agent's
historical data over the existing gRPC channel.

### Req-5: JSON/JSONL file elimination
The agent MUST stop writing `cron-log.jsonl` (replaced by cron_runs table). The `notification-mode.json`
file MUST be kept as-is (user-editable config, not application state).

## Scope
- **IN**: v3 schema migration (3 tables), cron DB persistence + JSONL removal, git event persistence, agent lifecycle tracking, 4 gRPC analytical RPCs, proto schema additions, retain pruning for v3 tables
- **OUT**: TUI analytics dashboard rendering (future), cross-machine SQLite replication, notification-mode.json migration (kept as user config), TUI gRPC client updates for new RPCs (separate spec)

## Impact
| Area | Change |
|------|--------|
| nexus-core/db.rs | v3 migration, 3 new tables, CRUD methods |
| nexus-agent/cron.rs + cron_state.rs | Write to DB, remove JSONL rotation |
| nexus-agent/services/git_watch.rs | Write events to DB instead of tracing-only |
| nexus-agent/main.rs | Log agent_lifecycle on start/shutdown |
| proto/nexus.proto | 4 new RPC definitions + response messages |
| nexus-agent/grpc/ | 4 new RPC handlers querying SQLite |

## Risks
| Risk | Mitigation |
|------|-----------|
| Proto schema changes require regeneration | build.rs handles this automatically |
| gRPC response size for large history queries | Default limits (100 rows), pagination via offset param |
| cron-log.jsonl removal breaks external readers | Log deprecation warning for 1 release; file is agent-internal |
