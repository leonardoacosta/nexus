# session-persistence

## ADDED Requirements

### Requirement: Session rows reflect real Claude Code processes

The agent SHALL only persist session rows that correspond to a real running
`claude` process on the agent's machine. Telemetry events from hooks, the
notification pipeline, or other auxiliary subsystems SHALL NOT create new
session rows on their own.

A session row is "real" if AT LEAST ONE of the following is populated at
write time: `pid > 0`, `tmuxTarget` non-empty, `ccSessionId` non-empty, or
`cwd` non-empty. Rows lacking all of these SHALL be rejected at insert time
with HTTP 422 (when surfaced via API) or silently dropped (when the upstream
is an internal hook).

#### Scenario: Hook event without matching session is dropped

- **GIVEN** the agent's `/hooks` endpoint receives a payload with `sessionId: "abc"`
- **AND** no session row exists with `id = "abc"`
- **THEN** the agent SHALL NOT insert a new row
- **AND** the agent SHALL log `hooks: orphan event sessionId=abc` at level `info`
- **AND** the response SHALL be `204 No Content`

#### Scenario: POST /session/start captures the spawned PID

- **GIVEN** the agent receives `POST /session/start` with valid `project` and `path`
- **AND** the agent successfully spawns the tmux window + `claude` process
- **THEN** the resulting session row SHALL have `pid` set to the spawned process ID
- **AND** `tmuxTarget` set to the window name
- **AND** `cwd` set to the `path` from the request body

#### Scenario: Process watcher reconciles dead PIDs

- **GIVEN** a session row exists with `pid = 12345`
- **AND** no process with PID 12345 exists on the agent's machine
- **WHEN** the process-watcher loop runs (every 30 seconds)
- **THEN** the agent SHALL set the row's `endedAt = NOW()` and `status = "ended"`
- **AND** emit a `RemoteSessionEnded` SSE event with the row's ID

#### Scenario: Process watcher detects new claude processes

- **GIVEN** the process-watcher loop runs
- **AND** `pgrep -af claude` returns a PID not present in any open session row
- **THEN** the agent SHALL insert a new session row with that PID
- **AND** the row's `model = "claude"`, `cwd` populated from `/proc/<pid>/cwd`,
  and `status = "active"`
- **AND** emit a `RemoteSessionStarted` SSE event

## ADDED Requirements

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
