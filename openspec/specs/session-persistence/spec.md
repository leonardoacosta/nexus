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

### Requirement: The sessions table MUST record the credential in effect at session start

The `sessions` table SHALL include two nullable columns: `credential_id` (foreign
key to `credentials.id`) and `credential_fingerprint` (denormalized copy of the
credential's fingerprint for aggregation rollup across duplicate groups). Both
columns MUST be populated at `session_start` from the credential pool's current
lease state. If no lease is active at `session_start`, both columns SHALL be
NULL and token tracking SHALL be skipped for that session without failing the
session lifecycle.

#### Scenario: Session start with active lease records credential
- **GIVEN** the credential pool has credential "c1" (fingerprint "fp-abc") leased
- **WHEN** a new session is created via `session_start`
- **THEN** the sessions row has `credential_id = "c1"` and `credential_fingerprint = "fp-abc"`

#### Scenario: Session start without lease leaves credential columns NULL
- **GIVEN** the credential pool has no active lease (passthrough mode)
- **WHEN** a new session is created via `session_start`
- **THEN** the sessions row has `credential_id = NULL` and `credential_fingerprint = NULL`
- **AND** no token watcher is attached for that session

#### Scenario: credential_fingerprint survives credential deletion
- **GIVEN** session "s1" was started with `credential_id = "c1"` and `credential_fingerprint = "fp-abc"`
- **WHEN** credential "c1" is deleted from the credentials table
- **THEN** `sessions.credential_fingerprint` on "s1" still equals "fp-abc"
- **AND** `GET /sessions/s1/tokens` aggregates still group under the "fp-abc" fingerprint

### Requirement: The system MUST attach a transcript token watcher on session start

On each `session_start` event, the agent SHALL compute the transcript JSONL path
as `~/.claude/projects/${cwd.replaceAll('/', '-')}/${cc_session_id}.jsonl` and
attach a tail watcher to that file. If the file does not exist at
`session_start`, the agent SHALL watch the parent directory via non-recursive
`fs.watch` for up to 5 seconds and attach the tail watcher when the file is
created. On 5-second timeout, the agent SHALL log a WARN once and skip token
tracking for the session without failing the session lifecycle.

#### Scenario: Transcript file exists immediately
- **GIVEN** the transcript JSONL file already exists at `session_start`
- **WHEN** the watcher lifecycle runs
- **THEN** the tail reader is attached and the first batch is parsed within one event loop tick

#### Scenario: Transcript file appears within 5s window
- **GIVEN** the transcript JSONL file does not exist at `session_start`
- **WHEN** the file is created 500ms later
- **THEN** the parent-directory watcher fires and the tail reader attaches to the new file

#### Scenario: Transcript file never appears within window
- **GIVEN** the transcript JSONL file does not exist at `session_start`
- **WHEN** the 5-second timeout elapses with no file creation
- **THEN** a WARN-level log is emitted once for that session
- **AND** no token watcher is attached
- **AND** the session lifecycle continues normally with NULL token data

### Requirement: Token watcher state MUST persist across agent restarts

The agent SHALL persist each active session's tail byte offset in a
`session_token_watcher_state` table keyed by `session_id`, with
`transcript_path`, `byte_offset`, and `updated_at` columns. The `byte_offset`
SHALL be updated in the same database transaction as each batch of inserted
turn rows. On agent startup, the agent SHALL load watcher state for every
session that is still active and resume tailing from the stored offset.

#### Scenario: Watcher resumes at stored offset after restart
- **GIVEN** session "s1" is active and the watcher has stored `byte_offset = 4096`
- **WHEN** the agent restarts
- **THEN** the tail reader opens the transcript file with `start: 4096` and continues parsing new lines from that position

#### Scenario: Resume after mid-batch crash does not produce duplicates
- **GIVEN** the watcher inserted 10 turn rows but crashed before persisting the new offset
- **WHEN** the agent restarts and resumes from the previous offset
- **THEN** the re-read attempts to re-insert the 10 rows
- **AND** the `UNIQUE(session_id, ts)` constraint rejects the duplicates without error
- **AND** the watcher advances past them on the next batch

#### Scenario: Stopped sessions do not resume
- **GIVEN** session "s2" has status `ended` and a stale `session_token_watcher_state` row
- **WHEN** the agent restarts
- **THEN** the watcher for "s2" is NOT reattached
- **AND** the stale watcher state row is pruned

### Requirement: The system MUST stop token watching on session stop

On each `session_stop` event, the agent SHALL flush any pending turn batch,
close the tail reader, and remove the session's row from
`session_token_watcher_state`. Subsequent reads of the transcript file SHALL
NOT be performed for ended sessions.

#### Scenario: Session stop flushes pending batch
- **GIVEN** the watcher has 3 parsed turns buffered but not yet inserted
- **WHEN** a `session_stop` event arrives for that session
- **THEN** the 3 turns are inserted in a final batch before the stream closes

#### Scenario: Session stop removes watcher state
- **GIVEN** session "s3" has a `session_token_watcher_state` row
- **WHEN** `session_stop` fires for "s3"
- **THEN** the watcher-state row is deleted in the same transaction as the final batch insert

### Requirement: Stale active sessions get retired by date heuristic

After deployment of `restore-hooks-event-persistence`, a one-time cleanup SHALL UPDATE all sessions with `started_at < 2026-04-24` AND `status='active'` to set `status='ended'` and `ended_at=started_at + INTERVAL '8 hours'` (heuristic median session length). This retires the 147 sessions stranded by the regression. The cleanup SHALL run as a startup migration, idempotent if re-applied.

#### Scenario: Stranded sessions are retired
- **GIVEN** 147 sessions exist with `started_at < 2026-04-24` and `status='active'`
- **WHEN** the agent starts after the migration is deployed
- **THEN** all 147 sessions are updated: `status='ended'`, `ended_at` set to a heuristic value
- **AND** subsequent restarts do not re-modify these sessions (idempotent)

### Requirement: Per-turn token aggregates table (optional, future-proofing)

When token aggregation across multiple `session_summary` events is needed (e.g., for per-phase attribution downstream), nexus MAY introduce a `session_token_aggregates` table. The table SHALL contain columns `(session_id, turn_index, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd, recorded_at)` when implemented. This requirement is OPTIONAL for this change and the actual table creation MAY be deferred to a follow-up proposal once concrete per-phase use cases land.

#### Scenario: Per-turn aggregates can be queried (when implemented)
- **GIVEN** session "abc" has 5 `session_summary` events with rising token counts
- **WHEN** the per-turn aggregates feature is enabled
- **THEN** `SELECT SUM(output_tokens) FROM session_token_aggregates WHERE session_id='abc'` returns the cumulative count
- **AND** the most recent row reflects the latest summary

### Requirement: GET /sessions supports a fingerprint filter

The `GET /sessions` endpoint SHALL accept an optional `withFingerprint=true`
query parameter. When present, the response SHALL include only rows where at
least one of `pid > 0`, `tmuxTarget != ""`, `ccSessionId != ""`, or
`cwd != ""` holds. Default (parameter absent) returns all rows for backward
compatibility.

#### Scenario: Filter returns only fingerprinted rows

- **GIVEN** the agent's DB has 10 rows, 3 with `pid > 0` and 7 with all
  discriminator fields null
- **WHEN** the client requests `GET /sessions?withFingerprint=true`
- **THEN** the response array SHALL contain exactly 3 rows

#### Scenario: Default behaviour unchanged

- **WHEN** the client requests `GET /sessions` (no query string)
- **THEN** the response SHALL include all rows regardless of fingerprint
- **AND** be byte-identical to the pre-spec behaviour

### Requirement: Agent resolves git project for every new session

The agent SHALL resolve git project metadata (`gitProvider`,
`gitOwnerRepo`, `projectId`) for every new session record. Resolution
MUST happen at ingest time (session_start hook OR process-watcher's
first poll), not at query time.

#### Scenario: cwd with git remote populates owner/repo

- **GIVEN** a session starts in `/home/nyaptor/dev/oo` and `git remote
  get-url origin` returns `https://github.com/leonardoacosta/oo.git`
- **WHEN** the agent ingests the session
- **THEN** the persisted row has `gitProvider=github`,
  `gitOwnerRepo=leonardoacosta/oo`, and `projectId=<oo project's id>`

#### Scenario: cwd outside a git repo emits null

- **WHEN** a session starts in `/tmp` (not a git repo)
- **THEN** the persisted row has `gitProvider=null`,
  `gitOwnerRepo=null`, `projectId=null`
- **AND** the agent does NOT throw; row insert proceeds

#### Scenario: cwd lookup failure is fail-soft

- **WHEN** `git remote get-url origin` exits non-zero or the cwd is
  unreadable
- **THEN** the resolver returns null for all three fields
- **AND** logs a debug-level note with the cwd

### Requirement: Resolver result cached per cwd for 30 seconds

The resolver SHALL cache `{cwd → result}` for 30 seconds. The
process-watcher's polling loop (default 30s tick) MUST NOT re-shell
`git remote` on every poll for unchanged cwds.

#### Scenario: second poll within 30s hits cache

- **GIVEN** the resolver was called for cwd `/home/nyaptor/dev/oo` at t=0
- **WHEN** the process-watcher polls again at t=15 with the same cwd
- **THEN** NO `git` subprocess spawns
- **AND** the cached result is returned

#### Scenario: cache expires after 30s

- **WHEN** the resolver is called for the same cwd at t=31
- **THEN** a fresh `git remote` subprocess is spawned
- **AND** the new result replaces the cached entry

### Requirement: process-watcher writes project fields

The process-watcher SHALL replace its hard-coded `projectId: null` with
a call to the git-project resolver before upserting a session row.
Existing rows with null project fields MAY be re-enriched on the next
poll.

#### Scenario: existing null-project row gets enriched on next poll

- **GIVEN** an active session row with `projectId: null` already exists
- **WHEN** the next poll fires and the resolver returns a project
- **THEN** the session row's `gitProvider`, `gitOwnerRepo`, `projectId`
  are updated to the resolved values
- **AND** `lastActivity` reflects the poll timestamp

### Requirement: sessions table SHALL carry sub-agent tree columns

The sessions schema SHALL include `parent_session_id` (text, nullable, references sessions.id) and `child_role` (text, nullable). An index SHALL be created on `parent_session_id` for tree queries.

#### Scenario: schema migration adds columns + index
- **GIVEN** a sessions table without the new columns
- **WHEN** the migration runs
- **THEN** both columns are added (NULL default) AND `idx_sessions_parent` index exists on `parent_session_id`

### Requirement: agent_spawn events SHALL populate tree columns

When an `agent_spawn` hook event arrives, the session manager SHALL extract `parent_agent` and `child_role` from the payload and persist them to the spawned session's row.

#### Scenario: child session linked to parent
- **GIVEN** session `oo-7f3a` exists and CC fires `agent_spawn` with `{session_id: 'oo-7f3a-child-01', parent_agent: 'oo-7f3a', child_role: 'Explore'}`
- **WHEN** the dispatcher processes the event
- **THEN** the `oo-7f3a-child-01` sessions row has `parent_session_id='oo-7f3a'` and `child_role='Explore'`

### Requirement: backfill script SHALL populate existing rows

A one-shot migration script SHALL replay all `session_events` WHERE `event_type='agent_spawn'`, extract `parent_agent` + `child_role`, and UPDATE the corresponding sessions row.

#### Scenario: tree query returns sub-agents
- **GIVEN** session `oo-7f3a` spawned 3 sub-agents (backfilled into the new columns)
- **WHEN** `SELECT id, child_role FROM sessions WHERE parent_session_id = 'oo-7f3a'`
- **THEN** returns 3 rows with their respective child roles

### Requirement: Session agent-state derivation

The agent SHALL derive and persist an `agentState` for each session — one of `blocked`,
`waiting`, or `ready` — from the Claude Code lifecycle hook stream, independent of the existing
`status` liveness field.

#### Scenario: Tool execution marks the session blocked

- **WHEN** the agent receives a `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, or
  `SubagentStart` hook for a session
- **THEN** the session's `agentState` SHALL be set to `blocked`

#### Scenario: Notification awaiting input marks the session waiting

- **WHEN** the agent receives a `Notification` hook indicating the agent is awaiting user input
  (permission prompt or idle notification)
- **THEN** the session's `agentState` SHALL be set to `waiting`

#### Scenario: Turn end marks the session ready

- **WHEN** the agent receives a `Stop` hook for a session
- **THEN** the session's `agentState` SHALL be set to `ready`

#### Scenario: agentState is exposed to clients

- **WHEN** a client fetches sessions via the agent's sessions route
- **THEN** each session payload SHALL include its current `agentState`

### Requirement: Session git branch capture

The agent SHALL populate each session's `branch` field with the current git branch of the
session's working directory, captured fail-soft.

#### Scenario: Branch resolved on session discovery

- **WHEN** the process-watcher creates or updates a session whose working directory is inside a
  git repository
- **THEN** the session's `branch` SHALL be set to the output of `git rev-parse --abbrev-ref HEAD`
  for that directory

#### Scenario: Non-git or failed resolution degrades cleanly

- **WHEN** the session's working directory is not a git repository, or the branch lookup fails
- **THEN** the session's `branch` SHALL be `null` and no error SHALL be surfaced to the user

### Requirement: Session row signal rendering

The dashboard session row SHALL present agent state and branch as its primary signals and SHALL
NOT render the originating-agent sentinel label.

#### Scenario: Row badge reflects agent state

- **WHEN** a session row is rendered
- **THEN** its status sigil SHALL reflect the session's `agentState` (`blocked`, `waiting`, or
  `ready`)

#### Scenario: Row subtitle shows branch

- **WHEN** a session row is rendered and the session has a non-empty `branch`
- **THEN** the row subtitle SHALL display the branch rather than the model name

#### Scenario: Agent-name sentinel is not shown

- **WHEN** a session row is rendered
- **THEN** the row SHALL NOT display the `"pinned"` originAgent sentinel label

### Requirement: Session model capture

The agent SHALL populate each session's `model` field from the live CC hook payload rather than
leave it at its managed-spawn placeholder, and SHALL keep it current across mid-session model
switches rather than capturing it only once at session start.

#### Scenario: Model captured on session start

- **WHEN** the agent receives a `session_start` hook event whose payload carries a non-empty
  `model` value
- **THEN** the session's `model` field SHALL be set to that value

#### Scenario: Model refreshed on a later heartbeat

- **WHEN** the agent receives a `session_heartbeat` hook event for an existing session whose
  payload carries a `model` value different from the session's current stored value
- **THEN** the session's `model` field SHALL be updated to the new value (last-write-wins)

#### Scenario: Missing model value does not clobber existing data

- **WHEN** a hook event's payload has no `model` field, or an empty one
- **THEN** the session's existing `model` value SHALL be left unchanged

### Requirement: GET /statusline surfaces a live model letter and composed session/account status

`GET /statusline` SHALL derive each session's `model` field in its response from the session
row's stored (raw) model value via the shared single-letter family mapping, rather than the
literal `null` it returned before `add-session-model-authority`. In addition, `GET /statusline`
SHALL accept optional `sessionId` and `accountId` query parameters, mutually exclusive, that
narrow the response to a single-entity composed status view:

- Neither param present: today's existing response (`sessions[]`, `git`, `machine`,
  `uptime_seconds`) is returned unchanged.
- `accountId` present, `sessionId` absent: the response is `{ account: Account5H7D }` — that
  account's 5-hour and 7-day Anthropic usage windows (`used`, `limit`, `resetsAt` for each),
  sourced from `credentials.usage5hUsed/Limit/ResetAt` and `usage7dUsed/Limit/ResetAt`. 404 when
  the account id is unknown.
- `sessionId` present, `accountId` absent: the response is `{ session: SessionStatus }`,
  composing: the session's model letter; its active credential's 5H/7D usage windows (via
  `sessions.credentialId`), null when unresolved; per-session cost usage from
  `readSessionCostTokens` (VictoriaMetrics-backed, per `cc-telemetry-read`); per-session-project
  beads/openspec/git status resolved via `sessions.projectId -> projects.name ->
  project_status_snapshots` latest row (null when the session has no resolvable project); and the
  next-action recommendation (same computation `GET /recommend` performed). 404 when the session
  id is unknown.
- Both params present: `400 { error: "sessionId and accountId are mutually exclusive" }`.

#### Scenario: Session with a captured model returns its letter (unchanged base behavior)

- **GIVEN** a session row whose `model` column holds `"claude-opus-4-8"`
- **WHEN** a client requests `GET /statusline` with no query params
- **THEN** that session's entry in the `sessions[]` response has `model: "O"`

#### Scenario: Session with no captured model returns null

- **GIVEN** a session row whose `model` column is `null` or empty
- **WHEN** a client requests `GET /statusline` with no query params
- **THEN** that session's entry has `model: null`

#### Scenario: accountId mode returns 5H/7D usage for one account

- **GIVEN** account "acct-1" has `usage5hUsed=30, usage5hLimit=50` and
  `usage7dUsed=200, usage7dLimit=500`
- **WHEN** a client requests `GET /statusline?accountId=acct-1`
- **THEN** the response is `200 { account: { accountId: "acct-1", fiveHour: { used: 30, limit: 50, ... }, sevenDay: { used: 200, limit: 500, ... } } }`

#### Scenario: accountId mode 404s on unknown account

- **GIVEN** no credential row with id "ghost" exists
- **WHEN** a client requests `GET /statusline?accountId=ghost`
- **THEN** the response status is 404

#### Scenario: sessionId mode composes model, usage, cost, and project status

- **GIVEN** session "s1" has `model="claude-sonnet-5"`, `credentialId="acct-1"`, and
  `projectId` resolving to project "nexus" with a `project_status_snapshots` row
  `{ beadsReadyUnlinked: 3, beadsBlockedUnlinked: 1, proposalsUnarchived: 2 }`
- **WHEN** a client requests `GET /statusline?sessionId=s1`
- **THEN** the response is `200` with `session.model === "S"`, `session.fiveHour`/`sevenDay`
  populated from account "acct-1", `session.project.beadsReadyUnlinked === 3`, and
  `session.usage.cost_usd` populated from `readSessionCostTokens`

#### Scenario: sessionId mode 404s on unknown session

- **GIVEN** no session with id "missing" exists
- **WHEN** a client requests `GET /statusline?sessionId=missing`
- **THEN** the response status is 404

#### Scenario: sessionId mode with unresolvable project returns null project status

- **GIVEN** session "s2" has `projectId=null`
- **WHEN** a client requests `GET /statusline?sessionId=s2`
- **THEN** the response is `200` with `session.project === null`

#### Scenario: Both params rejected

- **WHEN** a client requests `GET /statusline?sessionId=s1&accountId=acct-1`
- **THEN** the response is `400 { error: "sessionId and accountId are mutually exclusive" }`

### Requirement: Model family letter mapping is a single shared implementation

The system SHALL define the model-id/display-name to single-letter family mapping (fable,
opus, sonnet, haiku mapping to F, O, S, H respectively; an unknown family falling back to the
uppercased display-name initial; no model producing null) in exactly one shared location,
`packages/core`, consumed by both the agent's server-side derivation and any client-side
renderer, rather than duplicated per consumer.

#### Scenario: Agent and statusline renderer agree on the same letter

- **GIVEN** a model value `"claude-sonnet-5"`
- **WHEN** both `GET /statusline`'s server-side derivation and `apps/nexus-statusline`'s
  client-side renderer compute a family letter for it
- **THEN** both SHALL produce `"S"` via the same shared `packages/core` function, not two
  independently-maintained implementations

