# session-persistence Specification

## Purpose
TBD - created by archiving change add-sqlite-store. Update Purpose after archive.
## Requirements
### Requirement: The system MUST persist sessions to SQLite with write-through
The SessionRegistry MUST write session data to the `sessions` table on start, heartbeat, and stop
events. Sessions MUST survive agent restarts and be loadable from the database on startup. The DB
schema MUST include all fields present in the in-memory `Session` struct: `branch`, `session_type`,
`model`, `rate_limit_utilization`, `total_cost_usd`, `ended_at`, `rate_limit_reset_at`, `idle_since`,
`project_id`, `cc_session_id`, `tmux_session`, `tmux_target`, and `spec`. The `status` column MUST
accept the value `"ended"` in addition to `"active"`, `"idle"`, `"stale"`, and `"errored"`.

#### Scenario: Session start persisted
Given a new CC session registers via socket event
When the SessionRegistry creates the session entry
Then a corresponding row is inserted into the sessions table

#### Scenario: Session survives restart
Given 3 active sessions are in the database
When the agent restarts
Then the SessionRegistry loads all non-ended sessions from SQLite on startup

#### Scenario: Session end persisted
Given session "abc" is active in the database
When a session stop event arrives
Then `ended_at` is set and `status` is set to `"ended"` in the database

#### Scenario: Ended sessions excluded from startup load
Given sessions with status "ended" exist in the database
When the agent restarts and loads sessions
Then sessions with status "ended" are not re-admitted to the in-memory registry

#### Scenario: All session fields round-trip through DB
Given a session with branch "feature/x", session_type "ad_hoc", model "claude-opus-4",
and total_cost_usd 0.042 is persisted
When the agent restarts and loads the session from DB
Then all fields are restored with their original values

### Requirement: The system MUST serialize session_type as snake_case
The `SessionType` enum variants MUST serialize to lowercase snake_case strings: `"ad_hoc"`,
`"managed"`, `"pooled"`. The Rust `{:?}` debug formatter MUST NOT be used for serialization.
A `Display` implementation SHALL produce the canonical string form.

#### Scenario: AdHoc serializes as ad_hoc
- **WHEN** a session with `session_type = SessionType::AdHoc` is persisted to the database
- **THEN** the `session_type` column value is `"ad_hoc"`, not `"adhoc"` or `"AdHoc"`

#### Scenario: session_type round-trips through DB
- **WHEN** a session with `session_type = "managed"` is written and then read from the database
- **THEN** the deserialized `session_type` equals `SessionType::Managed`

### Requirement: Route handlers MUST return structured errors on DB failure
The `handleGetSessions` and `handleGetSessionById` route handlers MUST wrap all database calls
in try/catch blocks. On failure, they SHALL return HTTP 500 with a JSON body of the form
`{ "error": "internal error" }`. No unhandled promise rejection SHALL propagate to the HTTP layer.

#### Scenario: DB error in handleGetSessions returns 500
- **WHEN** the database throws during `queryActiveSessions` or `queryRecentSessions`
- **THEN** `handleGetSessions` returns an HTTP 500 response with JSON body `{ "error": "internal error" }`

#### Scenario: DB error in handleGetSessionById returns 500
- **WHEN** the database throws during `getSessionById`
- **THEN** `handleGetSessionById` returns an HTTP 500 response with JSON body `{ "error": "internal error" }`

#### Scenario: Valid requests are unaffected
- **WHEN** the database returns rows successfully
- **THEN** route handlers return HTTP 200 with the expected JSON body

### Requirement: Session integration tests MUST exercise real route logic
The `routes/sessions.test.ts` test suite MUST contain real assertions against the
`handleGetSessions` and `handleGetSessionById` handler functions using a live (or
in-memory) database. No test body SHALL consist solely of `expect(true).toBe(true)`.

#### Scenario: GET /sessions returns seeded sessions
- **WHEN** the database contains one active session and the test calls `handleGetSessions`
- **THEN** the response body contains that session

#### Scenario: GET /sessions/{id} returns 404 for unknown ID
- **WHEN** `handleGetSessionById` is called with a non-existent session ID
- **THEN** the response has status 404 and body `{ "error": "session not found" }`

#### Scenario: GET /sessions?status=invalid returns 400
- **WHEN** `handleGetSessions` is called with an unrecognized status query parameter
- **THEN** the response has status 400

### Requirement: The system MUST confirm process death before registry removal
After sending SIGKILL to a session process, the agent MUST poll for process termination before
removing the session from the registry. On Linux, the agent SHALL poll `/proc/{pid}` at 50ms
intervals for up to 2000ms. If the process has not died within the timeout, a warning SHALL be
logged and the session removed anyway.

#### Scenario: Process dies quickly — registry removed after confirmation
- **WHEN** a SIGKILL is sent to a process that exits within 200ms
- **THEN** the session is removed from the registry only after `/proc/{pid}` no longer exists

#### Scenario: Process death timeout — registry removed with warning
- **WHEN** a SIGKILL is sent but the process has not exited after 2000ms
- **THEN** the session is removed from the registry and a warning is logged

### Requirement: Stale and ended sessions MUST NOT block session restart for the same cwd
The session start dedup guard MUST use a whitelist: it SHALL only return an existing session
for the same `cwd` if that session's status is `Active` or `Idle`. Sessions with status
`Stale`, `Errored`, or `Ended` MUST NOT prevent a new session from being created at the same cwd.

#### Scenario: Stale session does not block restart
- **WHEN** a session at `/home/user/project` has status `Stale`
- **THEN** a new `StartSession` RPC for `/home/user/project` creates a new session

#### Scenario: Errored session does not block restart
- **WHEN** a session at `/home/user/project` has status `Errored`
- **THEN** a new `StartSession` RPC for `/home/user/project` creates a new session

#### Scenario: Active session triggers dedup return
- **WHEN** a session at `/home/user/project` has status `Active`
- **THEN** a new `StartSession` RPC for `/home/user/project` returns the existing session ID

### Requirement: Stale detection MUST apply to all sessions including managed
The `detect_stale` function in the SessionRegistry MUST evaluate all sessions for staleness
regardless of whether they have a `tmux_session` value. Managed sessions with expired heartbeats
SHALL be marked stale.

#### Scenario: Managed session with expired heartbeat is marked stale
- **WHEN** a session with `tmux_session = Some("main")` has a heartbeat older than the stale threshold
- **THEN** the session status is updated to `Stale`

#### Scenario: Managed session with recent heartbeat remains unchanged
- **WHEN** a session with `tmux_session = Some("main")` has a heartbeat within the stale threshold
- **THEN** the session status is unchanged

### Requirement: The TS session-manager MUST produce stale and errored status transitions
The `sweepIdle` function in `session-manager.ts` MUST transition sessions from `idle` to `stale`
when idle duration exceeds the stale threshold (default 300 seconds). On Linux, sessions whose
process no longer exists SHALL transition to `errored`.

#### Scenario: Idle session transitions to stale after threshold
- **WHEN** a session has status `idle` and its `lastHeartbeat` is more than 300s in the past
- **THEN** `sweepIdle` sets the session status to `stale`

#### Scenario: Ended session with no process transitions to errored on Linux
- **WHEN** a session has an associated pid and `/proc/{pid}` does not exist on Linux
- **THEN** `sweepIdle` sets the session status to `errored`

