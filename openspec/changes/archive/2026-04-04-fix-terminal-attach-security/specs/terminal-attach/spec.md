## MODIFIED Requirements

### Requirement: WebSocket PTY Authentication
The agent SHALL validate a shared secret before accepting any WebSocket upgrade on
`/sessions/{id}/stream` or `/sessions/{id}/interact`.  The secret is supplied by the connecting
client as the `X-Nexus-Secret` HTTP request header.  If the header is absent or does not match the
value of the `NEXUS_ATTACH_SECRET` environment variable, the server MUST return HTTP 401 and MUST
NOT perform the WebSocket upgrade.  If `NEXUS_ATTACH_SECRET` is not set at startup, the agent MUST
reject all attach connections (fail-closed).

#### Scenario: Valid secret allows upgrade
- **WHEN** a WebSocket upgrade request includes `X-Nexus-Secret: <correct-value>`
- **THEN** the server performs the upgrade and the connection is established

#### Scenario: Missing secret is rejected
- **WHEN** a WebSocket upgrade request omits the `X-Nexus-Secret` header
- **THEN** the server returns HTTP 401 and does not upgrade the connection

#### Scenario: Wrong secret is rejected
- **WHEN** a WebSocket upgrade request includes an incorrect `X-Nexus-Secret` value
- **THEN** the server returns HTTP 401 and does not upgrade the connection

#### Scenario: Unset env var causes fail-closed
- **WHEN** the agent starts without `NEXUS_ATTACH_SECRET` set
- **THEN** all attach upgrade requests are rejected with HTTP 401

### Requirement: WebSocket Connection Rate Limiting
The agent SHALL enforce a maximum number of concurrent WebSocket connections via the
`MAX_CONCURRENT_CONNECTIONS` constant (default: 50).  When a new upgrade request would cause the
active connection count to exceed this limit, the server MUST return HTTP 429 and MUST NOT perform
the upgrade.

#### Scenario: Upgrade refused at capacity
- **WHEN** the number of active WebSocket connections equals `MAX_CONCURRENT_CONNECTIONS`
- **AND** a new upgrade request arrives
- **THEN** the server returns HTTP 429 with a JSON error body

#### Scenario: Upgrade succeeds below capacity
- **WHEN** the number of active WebSocket connections is less than `MAX_CONCURRENT_CONNECTIONS`
- **AND** a new upgrade request arrives with a valid secret
- **THEN** the server performs the upgrade

### Requirement: Graceful Shutdown Drains PTY Sessions
The agent shutdown sequence MUST call `streamManager.shutdown()` before `server.stop()`.
`StreamManager.shutdown()` MUST call `endSession()` for every attached session, which closes all
viewer WebSockets, calls `pty.close()`, and cleans up internal state.

#### Scenario: SIGTERM with active PTY
- **WHEN** the agent receives SIGTERM while one or more PTY sessions are active
- **THEN** each session receives a `session_ended` message, all viewer sockets are closed, and no
  PTY child processes remain after the agent exits

#### Scenario: Idempotent double shutdown
- **WHEN** `streamManager.shutdown()` is called twice
- **THEN** no error is thrown and no duplicate close operations occur

### Requirement: Backpressure-Safe PTY Fan-Out
The `StreamManager` fan-out loop MUST check each viewer's `bufferedAmount` before calling
`sendBinary`.  If a viewer's `bufferedAmount` exceeds a configurable high-water mark
(default: 256 KiB), the implementation MUST skip that send.  A viewer that exceeds the high-water
mark on two consecutive fan-out ticks SHOULD be disconnected with close code 1008.

#### Scenario: Slow viewer is skipped under pressure
- **WHEN** a viewer's `bufferedAmount` exceeds the high-water mark during a fan-out tick
- **THEN** the data is NOT sent to that viewer in that tick
- **AND** all other viewers still receive the data

#### Scenario: Persistently slow viewer is disconnected
- **WHEN** a viewer's `bufferedAmount` exceeds the high-water mark on two consecutive ticks
- **THEN** the viewer WebSocket is closed with code 1008 and removed from the session

### Requirement: Clean PTY Cleanup on All Disconnect Paths
The PTY session MUST be ended (via `streamManager.endSession()`) when the last viewer disconnects,
regardless of how the disconnect occurred (normal close, pong timeout, or server stop).
`removeViewer` MUST call `endSession` when the viewer set becomes empty after removal.

#### Scenario: Last viewer closes normally
- **WHEN** the last remaining viewer WebSocket closes normally
- **THEN** `endSession` is called for that session, the PTY is closed, and the session is removed
  from internal state

#### Scenario: Pong timeout on last viewer
- **WHEN** the pong deadline fires for the only remaining viewer
- **THEN** `removeViewer` is called, `endSession` fires, and the PTY child process is reaped

#### Scenario: Multiple viewers — session survives partial disconnect
- **WHEN** one of two viewers disconnects
- **THEN** `endSession` is NOT called and the PTY remains active for the remaining viewer

### Requirement: Resize Input Validation
The WebSocket `message` handler MUST validate `resize` control frames before passing dimensions to
`pty.resize()`.  Valid values are finite integers satisfying `1 ≤ cols ≤ 500` and
`1 ≤ rows ≤ 300`.  Any out-of-range, non-finite, or non-integer value MUST cause the handler to
send a JSON error frame `{ "type": "error", "code": "invalid_resize" }` and return without calling
`pty.resize()`.

#### Scenario: Valid resize is applied
- **WHEN** a resize message with `cols: 120` and `rows: 40` is received
- **THEN** `pty.resize(120, 40)` is called

#### Scenario: NaN dimensions are rejected
- **WHEN** a resize message with `cols: NaN` or `rows: NaN` is received
- **THEN** an error frame is sent and `pty.resize` is not called

#### Scenario: Out-of-range dimensions are rejected
- **WHEN** a resize message with `cols: 0` or `rows: 9999` is received
- **THEN** an error frame is sent and `pty.resize` is not called

#### Scenario: Infinity dimensions are rejected
- **WHEN** a resize message with `cols: Infinity` is received
- **THEN** an error frame is sent and `pty.resize` is not called
