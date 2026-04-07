# terminal-attach Specification

## Purpose
TBD - created by archiving change fix-pty-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: PTY Session Lifecycle
The agent WebSocket server SHALL tear down a PTY session (call `endSession`) when the last viewer
disconnects, regardless of whether the disconnect was triggered by a normal WebSocket close or a
pong timeout. The server SHALL NOT leak PTY processes when viewer count reaches zero.

#### Scenario: Last viewer disconnects normally
- **WHEN** a session has exactly one viewer connected
- **AND** that viewer closes the WebSocket connection normally
- **THEN** `streamManager.removeViewer(ws)` is called
- **AND** `streamManager.viewerCount(sessionId)` returns 0
- **AND** `streamManager.endSession(sessionId)` is called immediately

#### Scenario: Last viewer times out
- **WHEN** a session has exactly one viewer connected
- **AND** that viewer fails to respond to a ping within the pong timeout
- **THEN** `streamManager.removeViewer(ws)` is called
- **AND** `streamManager.endSession(sessionId)` is called immediately

#### Scenario: Non-last viewer disconnects
- **WHEN** a session has two or more viewers connected
- **AND** one viewer closes the WebSocket connection
- **THEN** `streamManager.removeViewer(ws)` is called
- **AND** the session remains active for remaining viewers
- **AND** `streamManager.endSession(sessionId)` is NOT called

### Requirement: Interact Write Authorization
The agent WebSocket server SHALL enforce write authorization on the `interact` WebSocket endpoint.
Only the socket that has claimed the interactive writer mutex via `claimWriter()` SHALL be allowed
to forward input to the PTY. Unauthorized write attempts SHALL be rejected with an error frame.

#### Scenario: Authorized writer sends input
- **WHEN** a client connects in `interact` mode
- **AND** the client has previously called `claimWriter()` and holds the mutex
- **AND** the client sends a binary or text input frame
- **THEN** the input is forwarded to the PTY via `pty.write()`

#### Scenario: Unauthorized client sends input
- **WHEN** a client connects in `interact` mode
- **AND** the client has NOT claimed the writer mutex
- **AND** the client sends a binary or text input frame
- **THEN** the input is NOT forwarded to the PTY
- **AND** the server sends `{ "type": "error", "message": "not the interactive writer" }` back to the client

#### Scenario: Stream-mode client sends input
- **WHEN** a client connects in `stream` mode (read-only)
- **AND** the client sends any WebSocket message
- **THEN** the message is silently dropped
- **AND** no PTY write occurs

### Requirement: Viewer Reconnect and Output Resume
The agent WebSocket server SHALL support viewer reconnect so that a viewer that disconnects and
reconnects to the same session can receive output emitted during the gap, up to the capacity of
the in-memory replay buffer.

#### Scenario: Reconnecting viewer receives missed output
- **WHEN** a viewer was previously connected to a session
- **AND** the viewer disconnected
- **AND** the session emitted N lines of output during the disconnection gap
- **AND** the viewer reconnects and sends `{ "type": "reconnect", "sessionId": "<id>" }` as the first message
- **THEN** the server replays all buffered output from the gap as a binary burst
- **AND** the server sends `{ "type": "replay_done" }` after the replay burst

#### Scenario: Replay buffer capacity
- **WHEN** more than 1000 lines are emitted during a viewer's disconnection gap
- **AND** the viewer reconnects with a reconnect frame
- **THEN** the server replays up to 1000 lines (the most recent ones)
- **AND** older lines that exceed buffer capacity are not replayed

#### Scenario: Fresh connect (no reconnect frame)
- **WHEN** a viewer connects to an active session
- **AND** does NOT send a reconnect frame
- **THEN** the server sends the PTY scrollback buffer as the initial replay
- **AND** subsequent output is streamed in real time

### Requirement: Concrete PTY Source
The agent SHALL provide a concrete `PtySource` implementation backed by `node-pty` for production
terminal attach. The mock implementation (`MockPtySource`) SHALL remain available for test use only.

#### Scenario: NodePtySource spawns and streams
- **WHEN** a `NodePtySource` is constructed with a shell command and terminal dimensions
- **AND** a subscriber is registered via `onData()`
- **THEN** output from the spawned process is delivered to the subscriber as `Uint8Array` chunks

#### Scenario: NodePtySource write
- **WHEN** `write(data)` is called on a `NodePtySource`
- **THEN** the bytes are forwarded to the PTY stdin

#### Scenario: NodePtySource resize
- **WHEN** `resize(cols, rows)` is called on a `NodePtySource`
- **THEN** the PTY is resized to the given dimensions without error

#### Scenario: NodePtySource close
- **WHEN** `close()` is called on a `NodePtySource`
- **THEN** the spawned process is terminated
- **AND** all `onData` listeners are cleared
- **AND** subsequent calls to `write()` are no-ops

### Requirement: Test Server Isolation
The agent server SHALL expose a `createServer()` factory function that creates a fresh, independent
instance of all mutable server state (socket registry, pong deadline map, stream manager) per call.
Test suites SHALL use this factory to prevent state leakage between tests.

#### Scenario: Independent instances
- **WHEN** `createServer()` is called twice in the same process
- **THEN** each returned instance has its own `StreamManager`, socket set, and pong deadline map
- **AND** connecting a WebSocket to one instance does not affect the other instance's socket count

#### Scenario: Production server uses singleton state
- **WHEN** the agent process starts normally (not via test factory)
- **THEN** a single server instance is started on port 7400
- **AND** module-level state is used as before

### Requirement: WebSocket Auth Response
The agent WebSocket endpoints SHALL return HTTP 401 (Unauthorized) when a request is missing or
presents an invalid `x-nexus-secret` header, regardless of whether a PTY session exists for the
requested session ID.

#### Scenario: Missing secret on stream endpoint
- **WHEN** an HTTP GET request is made to `/sessions/{id}/stream` without a WebSocket upgrade
- **AND** the `x-nexus-secret` header is absent or incorrect
- **THEN** the response status is 401

#### Scenario: Missing secret on interact endpoint
- **WHEN** an HTTP GET request is made to `/sessions/{id}/interact` without a WebSocket upgrade
- **AND** the `x-nexus-secret` header is absent or incorrect
- **THEN** the response status is 401

### Requirement: Session ID Format
The agent SHALL accept session IDs that contain alphanumeric characters, hyphens, underscores,
and dots. Session IDs containing any other character SHALL be rejected with HTTP 400.

#### Scenario: Valid session ID with dots
- **WHEN** a WebSocket upgrade request targets `/sessions/session.2026-04-06.1/stream`
- **AND** the request carries a valid `x-nexus-secret`
- **THEN** the session ID is accepted (proceeds to PTY lookup, not rejected with 400)

#### Scenario: Invalid session ID with slash
- **WHEN** a WebSocket upgrade request targets a session ID containing `/`
- **THEN** the response status is 400

### Requirement: Scrollback Replay Format
The agent SHALL send scrollback replay data such that each output line is followed by exactly one
newline character. Lines that already contain embedded newlines SHALL NOT produce double newlines
in the replay stream.

#### Scenario: Single-line scrollback
- **WHEN** the PTY scrollback contains one line `"hello"` (no trailing newline)
- **AND** a viewer connects and receives the initial replay
- **THEN** the replay bytes decode to `"hello\n"` (exactly one newline)

#### Scenario: Multi-line scrollback
- **WHEN** the PTY scrollback contains lines `["foo", "bar"]`
- **AND** a viewer connects and receives the initial replay
- **THEN** the replay bytes decode to `"foo\nbar\n"` (no double newlines)

### Requirement: Browser XTerminal Token Injection
The Next.js `XTerminal` component SHALL append `?token=<secret>` to the WebSocket URL
before connecting, sourcing the token from a server-rendered prop or a protected
`/api/ws-token` API route. The token SHALL NOT be embedded in the client-side JavaScript
bundle as a `NEXT_PUBLIC_*` environment variable. This satisfies the WebSocket upgrade
auth requirement when the caller is a browser (which cannot set custom HTTP headers).

#### Scenario: XTerminal connects successfully in stream mode
- **WHEN** the `XTerminal` component mounts with `mode="stream"` and a valid session ID
- **AND** the server-rendered `wsToken` prop contains the correct `NEXUS_ATTACH_SECRET`
- **THEN** the component constructs a URL of the form
  `ws://<host>/sessions/<id>/stream?token=<secret>` and the WebSocket handshake succeeds

#### Scenario: XTerminal connects successfully in interact mode
- **WHEN** the `XTerminal` component mounts with `mode="interact"` and a valid session ID
- **AND** the `wsToken` prop contains the correct secret
- **THEN** the component constructs a URL of the form
  `ws://<host>/sessions/<id>/interact?token=<secret>` and the handshake succeeds

#### Scenario: Missing token results in 401 and retry cycle
- **WHEN** the `XTerminal` component mounts but `wsToken` is empty or undefined
- **THEN** the WebSocket upgrade is rejected with HTTP 401
- **AND** the component displays an error status rather than silently retrying indefinitely

#### Scenario: Token not visible in client bundle
- **WHEN** the Next.js app is built and the `_next/static/` output is inspected
- **THEN** the value of `NEXUS_ATTACH_SECRET` is not present in any static asset

