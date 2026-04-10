# Implementation Tasks

<!-- beads:epic:nx-sknk -->

## API Batch

- [ ] [1.1] [P-1] Add `loadActiveSessions()` query to `apps/agent/src/db/sessions.ts`: SELECT all sessions WHERE ended_at IS NULL, return as Session[] for cache population [owner:api-engineer]
- [ ] [1.2] [P-1] Add `upsertSession()` to `apps/agent/src/db/sessions.ts`: INSERT OR UPDATE session by ID — used for write-through from session-manager [owner:api-engineer]
- [ ] [1.3] [P-2] Refactor `apps/agent/src/session-manager.ts` to accept DB at construction: load active sessions from DB on init, validate PIDs via `/proc/{pid}`, mark dead PIDs as ended [owner:api-engineer]
- [ ] [1.4] [P-2] Implement write-through: all session mutations (handleWatcherEvent for start/heartbeat/stop) write to Postgres first via upsertSession/updateSession, then update in-memory Map. Fail mutation if DB write fails. [owner:api-engineer]
- [ ] [1.5] [P-2] Implement read-through: getSession(id) checks Map first, falls back to DB query on miss. listSessions() serves from Map (pre-populated). Cache-miss results are added to Map. [owner:api-engineer]
- [ ] [1.6] [P-3] Update sweep logic: sweepIdle() iterates the in-memory Map (fast), writes status changes to DB. Remove sessions from Map when ended + TTL expired. [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Write integration tests: start session via watcher event, verify it appears in both Map and DB, restart session-manager, verify session recovered from DB [owner:e2e-engineer]
- [ ] [2.2] Write PID validation test: create session with dead PID, init session-manager, verify it's marked ended in DB [owner:e2e-engineer]
- [ ] [2.3] Write write-through failure test: mock DB to reject writes, verify session mutation fails and Map is not updated [owner:e2e-engineer]
