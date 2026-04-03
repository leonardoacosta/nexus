## 1. Schema and Migrations
- [ ] [1.1] Create migrations directory at apps/agent/migrations/ with numbered SQL files [owner:engineer]
- [ ] [1.2] Write 001_init.sql: CREATE TABLE sessions (id TEXT PK, project, machine, status, started_at, last_activity, ended_at, pid, cwd) [owner:engineer]
- [ ] [1.3] Write 001_init.sql: CREATE TABLE health_snapshots (id INTEGER PK AUTOINCREMENT, timestamp, cpu_percent, ram_percent, disk_percent, docker_containers, raw_json) [owner:engineer]
- [ ] [1.4] Write 001_init.sql: CREATE TABLE session_events (id INTEGER PK AUTOINCREMENT, session_id FK, event_type, timestamp, metadata) [owner:engineer]
- [ ] [1.5] Implement migration runner: read applied migrations from _migrations table, apply new ones in order on startup [owner:engineer]

## 2. Database Setup
- [ ] [2.1] Initialize bun:sqlite database at ~/.config/nexus/nexus.db with WAL mode enabled [owner:engineer]
- [ ] [2.2] Wire migration runner into agent startup before accepting requests [owner:engineer]

## 3. Session Queries
- [ ] [3.1] Implement insertSession: insert new session row [owner:engineer]
- [ ] [3.2] Implement updateSessionStatus: update status and last_activity (and ended_at when status=ended) [owner:engineer]
- [ ] [3.3] Implement queryActiveSessions: SELECT where status IN ('active', 'idle') [owner:engineer]
- [ ] [3.4] Implement queryRecentSessions: SELECT recently ended sessions (last 24 hours) [owner:engineer]
- [ ] [3.5] Implement getSessionById: SELECT single session by id [owner:engineer]

## 4. Health Snapshot Queries
- [ ] [4.1] Implement insertHealthSnapshot: insert snapshot with timestamp and metrics [owner:engineer]
- [ ] [4.2] Implement queryHealthTimeSeries: SELECT snapshots for last N hours, ordered by timestamp, sparkline-ready [owner:engineer]

## 5. Session Event Queries
- [ ] [5.1] Implement appendSessionEvent: INSERT event with session_id, event_type, timestamp, metadata JSON [owner:engineer]
- [ ] [5.2] Implement querySessionEvents: SELECT events for a given session_id, ordered by timestamp [owner:engineer]

## 6. Retention
- [ ] [6.1] Implement retention cleanup: DELETE health_snapshots older than 30 days, session_events older than 90 days [owner:engineer]
- [ ] [6.2] Schedule retention cleanup to run on agent startup and every 24 hours thereafter [owner:engineer]

## 7. Validation
- [ ] [7.1] Write tests for migration runner: apply migrations to in-memory DB, verify schema [owner:engineer]
- [ ] [7.2] Write tests for session CRUD: insert, update status, query active, query recent [owner:engineer]
- [ ] [7.3] Write tests for health snapshot insert and time-series query [owner:engineer]
- [ ] [7.4] Write tests for session event append and query [owner:engineer]
- [ ] [7.5] Write test for retention cleanup: insert old records, run cleanup, verify deleted [owner:engineer]
