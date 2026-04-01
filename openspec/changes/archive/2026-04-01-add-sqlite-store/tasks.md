# Implementation Tasks

<!-- beads:epic:nx-6y7 -->

## Database Foundation Batch

- [ ] [1.1] [P-1] Create `crates/nexus-core/src/db.rs` with `NexusDb` struct wrapping `Mutex<rusqlite::Connection>`, `open(path)` constructor with WAL mode + busy timeout, `write()` and `read()` accessor methods [owner:engineer]
- [ ] [1.2] [P-1] Implement schema migration system: `migrate()` checks `PRAGMA user_version`, runs versioned SQL scripts in order, updates version after each [owner:engineer]
- [ ] [1.3] [P-1] Add v1 migration: CREATE TABLE specs, sessions, failures, events with indexes per design.md schema [owner:engineer]
- [ ] [1.4] [P-2] Add `pub mod db;` to nexus-core lib.rs, ensure `rusqlite` dependency has `bundled` feature for zero-config builds [owner:engineer]
- [ ] [1.5] [P-2] Add retention cleanup functions: `prune_old_records(days)` for sessions/failures/events (30d) and specs (90d archived) [owner:engineer]
- [ ] [1.6] [P-2] Add unit tests: database creation, migration idempotency, version guard (future version refuses), WAL mode verification [owner:engineer]

## Spec Governance Batch

- [ ] [2.1] [P-1] Add spec CRUD methods to NexusDb: `upsert_spec()`, `get_spec()`, `list_specs()`, `update_spec_status()`, `update_spec_tasks()` [owner:engineer]
- [ ] [2.2] [P-1] Add `proposal_hash()` helper to nexus-core: SHA-256 of proposal.md file content, returns hex string [owner:engineer]
- [ ] [2.3] [P-1] Modify spec_watcher.rs: on each poll, upsert discovered specs into DB with parsed title, summary, task counts, proposal_hash. Use DB as source of truth for change detection instead of in-memory HashMap [owner:engineer]
- [ ] [2.4] [P-2] Implement hash change detection: if proposal_hash differs and status is read/approved, reset to unread + clear timestamps + emit TTS notification [owner:engineer]
- [ ] [2.5] [P-2] Implement spec removal detection: if spec no longer on disk but in DB as applied, update to archived [owner:engineer]
- [ ] [2.6] [P-2] Add unit tests for spec CRUD, status transitions, hash change reset logic [owner:engineer]

## Agent Wiring Batch

- [ ] [3.1] [P-1] Initialize NexusDb in main.rs on startup, run migrations, store as `Arc<NexusDb>` on AppState [owner:engineer]
- [ ] [3.2] [P-1] Pass `Arc<NexusDb>` to SpecWatcherService constructor [owner:engineer]
- [ ] [3.3] [P-2] Wire retain cron: add `db.prune_old_records()` call to the existing `maintain` cron job [owner:engineer]

## Session Persistence Batch

- [ ] [4.1] [P-1] Add session CRUD methods to NexusDb: `insert_session()`, `update_session()`, `end_session()`, `load_active_sessions()` [owner:engineer]
- [ ] [4.2] [P-1] Add write-through calls in SessionRegistry: insert on register, update on heartbeat/telemetry, end on stop [owner:engineer]
- [ ] [4.3] [P-2] Load active (non-ended) sessions from DB on agent startup into SessionRegistry [owner:engineer]
- [ ] [4.4] [P-2] Add unit tests for session persistence round-trip [owner:engineer]

## Failure Store Batch

- [ ] [5.1] [P-1] Add failure CRUD methods to NexusDb: `insert_failure()`, `query_failures(filters)`, `count_by_tool()`, `count_by_project()`, `recent_trend()` [owner:engineer]
- [ ] [5.2] [P-1] Replace FailureBuffer VecDeque with SQLite-backed queries — remove in-memory ring buffer, write directly to DB [owner:engineer]
- [ ] [5.3] [P-2] Update /failures HTTP endpoint to use SQL queries instead of hand-rolled aggregation [owner:engineer]
- [ ] [5.4] [P-2] Remove JSONL bootstrap code from failures.rs (no longer needed — DB is source of truth) [owner:engineer]
- [ ] [5.5] [P-2] Add unit tests for failure aggregation queries [owner:engineer]

## Audit Events Batch

- [ ] [6.1] [P-1] Add event logging method to NexusDb: `log_event(event_type, actor, target, details_json)` [owner:engineer]
- [ ] [6.2] [P-2] Add event logging calls at key points: session start/stop, credential swap, spec status change, notification sent [owner:engineer]
- [ ] [6.3] [P-2] Add `GET /events` HTTP endpoint with optional type/target filters [owner:engineer]

## HTTP API Batch

- [ ] [7.1] [P-1] Add `GET /specs` endpoint returning specs from DB with status filter (?status=unread&status=read) [owner:engineer]
- [ ] [7.2] [P-1] Add `POST /specs/:project/:name/approve` endpoint updating spec status to approved [owner:engineer]
- [ ] [7.3] [P-1] Add `POST /specs/:project/:name/reject` endpoint with optional reason body [owner:engineer]
- [ ] [7.4] [P-2] Add `GET /specs/:project/:name` endpoint returning single spec detail with full proposal text [owner:engineer]

## MCP Tools Batch

- [ ] [8.1] [P-1] Add `get_pending_specs` tool to nexus-mcp — proxies GET /specs?status=unread&status=read [owner:engineer]
- [ ] [8.2] [P-1] Add `approve_spec` tool to nexus-mcp — proxies POST /specs/:project/:name/approve [owner:engineer]
- [ ] [8.3] [P-1] Add `reject_spec` tool to nexus-mcp — proxies POST /specs/:project/:name/reject [owner:engineer]

## TUI Spec Review Screen Batch

- [ ] [9.1] [P-1] Add Specs screen to TUI navigation (new tab alongside Dashboard, Health, Projects) [owner:engineer]
- [ ] [9.2] [P-1] Implement spec list view — fetch from agent GET /specs, show project, name, status, tasks progress, grouped by status (unread first, then read, then approved) [owner:engineer]
- [ ] [9.3] [P-1] Implement spec detail view — show proposal.md content rendered as markdown, task list with completion checkmarks [owner:engineer]
- [ ] [9.4] [P-2] Auto-mark as 'read' when detail view is opened — POST to agent /specs/:project/:name/read [owner:engineer]
- [ ] [9.5] [P-2] Add 'a' keybinding to approve, 'x' to reject (with reason prompt) from detail view [owner:engineer]
- [ ] [9.6] [P-2] Show "N specs pending" count in TUI status bar across all screens [owner:engineer]

## Approval Gate Batch

- [ ] [10.1] [P-1] Add `GET /specs/:project/:name/status` endpoint returning just the approval status [owner:engineer]
- [ ] [10.2] [P-2] Document the approval gate check that /apply and /apply:all skills should perform: HTTP GET to agent, check status='approved', block with message if not [owner:engineer]

## Verification Batch

- [ ] [11.1] Verify `cargo build` succeeds for all workspace crates [owner:engineer]
- [ ] [11.2] Verify `cargo test` passes with new DB, governance, session, failure, and event tests [owner:engineer]
- [ ] [11.3] Verify `cargo clippy` reports no new warnings [owner:engineer]
