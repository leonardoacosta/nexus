# Proposal: SQLite Phase 2 — Analytics Tables

## Change ID
`add-sqlite-analytics`

## Summary
Add 5 analytics tables to nexus.db (v2 migration) for time-series health data, spec delivery
velocity, credential usage patterns, credential swap audit trails, and searchable notification
history. Each existing service writes to its corresponding table.

## Context
- Extends: `crates/nexus-core/src/db.rs` (v2 migration, new CRUD methods), `crates/nexus-agent/src/health.rs`, `crates/nexus-agent/src/services/spec_watcher.rs`, `crates/nexus-agent/src/services/credential_pool.rs`, `crates/nexus-agent/src/rate_limit_interceptor.rs`, `crates/nexus-agent/src/services/receiver/`
- Related: `add-sqlite-store` (Phase 1 — foundation + governance, completed)

## Motivation
Phase 1 established the database foundation with governance, sessions, failures, and events. Phase 2
adds the analytics layer — time-series data that enables trend visualization, pattern detection,
and historical queries. Health sampling enables TUI sparklines. Spec timeseries tracks delivery
velocity. Credential analytics reveal rotation patterns. Notification history becomes searchable.
These tables also eliminate the `usage-cache.json` file and the ephemeral notification history.

## Requirements

### Req-1: Health time-series sampling
The HealthCollector MUST write CPU, memory, disk, and load samples to SQLite every 30 seconds,
enabling historical health queries and future TUI sparkline charts.

### Req-2: Spec delivery timeseries
The spec watcher MUST record timestamped task completion snapshots per spec per project, enabling
delivery velocity metrics (time from proposal to archive, tasks/week).

### Req-3: Credential usage analytics
The credential pool MUST persist per-account utilization snapshots to SQLite on each poll,
replacing `usage-cache.json`. The rate limit interceptor MUST log swap events with from/to
account and trigger session.

### Req-4: Notification history store
The receiver service MUST persist delivered notifications to SQLite with message, type, project,
channels, and delivery status, enabling searchable/filterable notification history.

### Req-5: Analytics HTTP endpoints and MCP tools
The agent MUST expose `GET /analytics/health`, `GET /analytics/specs`, `GET /analytics/credentials`
endpoints. The MCP server MUST expose `get_health_history` and `get_credential_history` tools.

## Scope
- **IN**: v2 schema migration (5 tables), service write-through for each table, 3 analytics HTTP endpoints, 2 MCP tools, eliminate usage-cache.json, 30-day retention for all analytics tables
- **OUT**: TUI sparkline rendering (future), cross-machine analytics aggregation (Phase 3), notification search UI in TUI (future), gRPC analytical RPCs (Phase 3)

## Impact
| Area | Change |
|------|--------|
| nexus-core/db.rs | v2 migration, 5 new tables, CRUD methods per table |
| nexus-agent/health.rs | Write health samples every 30s |
| nexus-agent/services/spec_watcher.rs | Write spec snapshots on each poll |
| nexus-agent/services/credential_pool.rs | Write poll results to DB, replace usage-cache.json |
| nexus-agent/rate_limit_interceptor.rs | Log swap events to credential_swaps table |
| nexus-agent/services/receiver/ | Write notifications to DB |
| nexus-agent/http_handlers.rs | 3 new analytics endpoints |
| nexus-mcp/main.rs | 2 new MCP tools |

## Risks
| Risk | Mitigation |
|------|-----------|
| Health sampling at 30s = ~2,880 rows/day | 30-day retention prunes to ~86K rows max; SQLite handles millions easily |
| Write contention from 5 services | WAL mode; writes are <1ms each; no hot-path blocking |
| usage-cache.json removal breaks nexus-status | nexus-status reads its own cache independently; agent's cache is separate |
