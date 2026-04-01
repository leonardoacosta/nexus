# Proposal: SQLite Backing Store Phase 1 — Foundation + Spec Governance

## Change ID
`add-sqlite-store`

## Summary
Introduce a SQLite database as the persistent backing store for nexus-agent, anchored by spec
governance (approval workflow) and including session persistence, failure aggregation, and audit
logging. Phase 1 of a 3-phase rollout.

## Context
- Extends: `crates/nexus-core/` (new db module), `crates/nexus-agent/src/services/spec_watcher.rs` (write to DB), `crates/nexus-agent/src/registry.rs` (session write-through), `crates/nexus-agent/src/failures.rs` (replace VecDeque), `crates/nexus-tui/` (new spec review screen), `crates/nexus-mcp/` (approve/reject tools)
- Related: `add-spec-watcher` (currently in-memory, becomes DB-backed), `add-credential-rotation` (Phase 2 will add credential tables)

## Motivation
Nexus currently holds 13 distinct ephemeral data stores in memory. Every restart loses session
histories, spec review status, failure trends, and audit trails. Most critically, specs created
by agents are immediately executable without human review. The SQLite store enables spec governance
— Leo reviews and approves specs before implementation — while also replacing hand-rolled
aggregation code (~350 lines) with SQL queries. This is Phase 1 of 3: foundation + governance
now, analytics in Phase 2, full consolidation in Phase 3.

## Requirements

### Req-1: Database foundation
Create `~/.config/nexus/nexus.db` with WAL mode, schema migrations via `PRAGMA user_version`,
and a shared connection accessible to all agent services.

### Req-2: Spec governance table
Track spec lifecycle: `unread → read → approved → rejected → applied → archived`. The spec watcher
writes discovered specs to the DB. The TUI surfaces unread/pending specs for review. MCP tools
allow approval/rejection. Both `/apply` and `/apply:all` check for `approved` status before
execution.

### Req-3: Session persistence
Write-through from SessionRegistry to SQLite. Sessions survive restarts. Historical session data
enables future analytics (Phase 2).

### Req-4: Failure store
Replace the in-memory FailureBuffer VecDeque + JSONL bootstrap with a `failures` table. Complex
aggregation queries (by_tool, by_project, trend, top_errors) become SQL replacing ~200 lines of
hand-rolled Rust code.

### Req-5: Audit event log
Every significant action (session start/stop, credential swap, spec approval, notification sent)
gets a row in the `events` table. Replaces the fire-and-forget EventBroadcaster with a persistent,
queryable audit trail.

## Scope
- **IN**: Database creation + migrations, `specs` table with governance workflow, `sessions` table with write-through, `failures` table replacing VecDeque, `events` audit table, TUI spec review screen, MCP approve/reject tools, `/apply` + `/apply:all` approval gate, 30-day retention via maintain cron
- **OUT**: Phase 2 tables (health_samples, spec_snapshots, credential_polls, credential_swaps, notifications), Phase 3 tables (cron_runs, git_events, agent_lifecycle), gRPC analytical RPCs, cross-machine SQLite replication, TUI analytics dashboards

## Impact
| Area | Change |
|------|--------|
| nexus-core | New `db.rs` module with schema, migrations, connection factory |
| nexus-agent/services | spec_watcher writes to DB instead of HashMap |
| nexus-agent/registry | Session write-through to SQLite on start/stop/heartbeat |
| nexus-agent/failures | Replace VecDeque + JSONL with SQLite queries |
| nexus-agent/main.rs | Initialize DB, pass connection to services |
| nexus-tui | New spec review screen (list unread, view detail, approve/reject) |
| nexus-mcp | New approve_spec, reject_spec tools |
| /apply skill | Check specs.status = 'approved' before execution |

## Risks
| Risk | Mitigation |
|------|-----------|
| SQLite write contention under load | WAL mode allows concurrent reads; writes are serialized but fast (<1ms per INSERT) |
| DB corruption on unclean shutdown | WAL mode + checkpoint on graceful shutdown; SQLite is crash-safe by design |
| Schema migration failures | Version check on startup; refuse to start if version > expected (forward-compatible) |
| TUI latency from DB reads | Hot-path reads stay in-memory (SessionRegistry); DB is source-of-truth for cold reads |
| Proposal hash mismatch after spec edit | Re-hash on each poll; if hash changes after read/approved, reset to unread + TTS notify |
