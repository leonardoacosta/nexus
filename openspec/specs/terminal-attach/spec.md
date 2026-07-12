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

### Requirement: Server-side origin check blocks non-Tailscale origins
Requests to the agent HTTP server from non-Tailscale origins (as determined by `isTailscaleOrigin` — Origin header hostname matching `^100\.`) SHALL receive a `403 Forbidden` response. This check is defense-in-depth on top of the existing `x-nexus-secret` auth; the auth header remains the primary gate.

#### Scenario: Non-Tailscale browser request is blocked
- **GIVEN** a request with `Origin: https://evil.example.com` and valid `x-nexus-secret` header
- **WHEN** the request hits a non-OPTIONS agent endpoint
- **THEN** the response SHALL be `403 Forbidden`
- **AND** the response body SHALL be a short error (e.g., `{ "error": "origin not allowed" }`)

#### Scenario: Tailscale browser request passes
- **GIVEN** a request with `Origin: https://100.123.45.67` and valid `x-nexus-secret`
- **WHEN** the request hits any agent endpoint
- **THEN** the request SHALL proceed normally (existing auth/routing applies)
- **AND** the response SHALL include the existing CORS headers (`Access-Control-Allow-Origin`, etc.)

#### Scenario: No Origin header passes through
- **GIVEN** a non-browser client (curl, wscat) that doesn't send an `Origin` header, with valid `x-nexus-secret`
- **WHEN** the request hits an agent endpoint
- **THEN** the request SHALL proceed normally
- **AND** the origin check SHALL NOT block it (the auth header is the gate for non-browser clients)

#### Scenario: CORS preflight (OPTIONS) is exempt from origin block
- **GIVEN** a preflight `OPTIONS` request with `Origin: https://100.123.45.67`
- **WHEN** the request is processed
- **THEN** the preflight SHALL return 204/200 with CORS headers
- **AND** the origin check SHALL NOT return 403 (browsers need preflight to succeed before sending the real request)

#### Scenario: Malformed Origin header treated as no-Origin
- **GIVEN** a request with `Origin: not-a-url`
- **WHEN** `isTailscaleOrigin` can't parse the URL
- **THEN** the request SHALL be treated as if Origin is absent (proceed via auth gate)
- **AND** the server SHALL NOT crash on invalid Origin values

### Requirement: PtyViewer forwards keystrokes to the agent's tmux pane

PtyViewer SHALL forward SwiftTerm keystroke events to the agent via
`POST /commands/send-text`. Read-only mode is replaced with
bidirectional input. The SwiftTerm `terminalDelegate.send()` callback
MUST invoke `NexusClient.sendText(sessionId:, text:)` instead of
discarding bytes.

#### Scenario: typing a character sends it to the tmux pane

- **GIVEN** PtyViewer is open with a managed session's stream loaded
- **WHEN** the user types `ls` followed by Enter
- **THEN** SwiftTerm captures each character event
- **AND** each event triggers an HTTP `POST /commands/send-text` with
  body `{sessionId, text}`
- **AND** the homelab tmux pane receives the keys via
  `tmux send-keys -t <target>`

#### Scenario: control characters forward correctly

- **GIVEN** PtyViewer is open
- **WHEN** the user types Ctrl-C
- **THEN** the byte `\x03` is forwarded
- **AND** the tmux pane processes the interrupt

#### Scenario: input forwarding only on managed sessions

- **WHEN** PtyViewer is opened for a session whose `sessionType` is
  not `"managed"`
- **THEN** input forwarding is disabled (SwiftTerm delegate is no-op)
- **AND** an os_log warn line documents the suppression

### Requirement: Send-text endpoint accepts session-scoped input

The agent's `POST /commands/send-text` endpoint SHALL accept
`{sessionId, text}` JSON bodies and forward via
`tmux send-keys -t <session.tmuxTarget>`.

#### Scenario: valid sessionId routes to tmux target

- **GIVEN** a managed session with `tmuxTarget="nexus:cc-1617726"`
- **WHEN** the client POSTs `{sessionId: "<id>", text: "ls\r"}`
- **THEN** the agent runs `tmux send-keys -t nexus:cc-1617726 'ls\r'`
- **AND** returns 200 with body `{ok: true}`

#### Scenario: unknown sessionId returns 404

- **WHEN** the client POSTs a sessionId that does not exist in the
  sessions table
- **THEN** the agent returns 404 with body `{error: "not found"}`
- **AND** does NOT invoke tmux

### Requirement: TmuxPtySource Spawn Seam

`TmuxPtySource` SHALL accept an injectable spawn adapter so its tmux argv construction can be
unit-tested without a live tmux server. The adapter SHALL default to Bun's `spawn`/`spawnSync`,
producing byte-for-byte identical behavior in production.

#### Scenario: Default adapter preserves production behavior

- **WHEN** `TmuxPtySource` is constructed without an explicit spawn adapter
- **THEN** it uses `Bun.spawnSync` and `Bun.spawn` exactly as before — no argv, ordering, or
  lifecycle change versus the pre-seam implementation

#### Scenario: Injected adapter records argv

- **WHEN** a recording spawn adapter is injected and the source performs scrollback seed,
  geometry sample, pipe-pane setup, write, resize, and close
- **THEN** every tmux invocation is captured with its full argument vector for assertion, and
  no real tmux process is spawned

### Requirement: TmuxPtySource Argv Correctness

The argv `TmuxPtySource` constructs for each tmux operation SHALL be asserted by unit tests, so
a regression in any command's flags fails before it ships.

#### Scenario: Scrollback seed argv

- **WHEN** the source seeds scrollback at construction
- **THEN** it invokes `tmux capture-pane -p -S -<lines> -E - -t <target>`

#### Scenario: Geometry sample argv

- **WHEN** the source samples pane geometry
- **THEN** it invokes `tmux display-message -p -t <target> #{pane_width}x#{pane_height}` and
  parses the `<cols>x<rows>` response

#### Scenario: Literal write argv (no auto-Enter)

- **WHEN** `write()` is called with input bytes
- **THEN** it invokes `tmux send-keys -t <target> -l <text>` — the `-l` literal flag is present
  so the text is inserted without an implicit Enter

#### Scenario: Resize forces manual window-size once

- **WHEN** `resize(cols, rows)` is called for the first time on a source
- **THEN** the source reads the prior `window-size` option, sets it to `manual`, then invokes
  `tmux resize-window -t <target> -x <cols> -y <rows>`
- **AND WHEN** `resize` is called again on the same source, the prior `window-size` is NOT
  re-read or re-set (capture happens exactly once)

#### Scenario: Auto-restore reverts window-size

- **WHEN** `restoreWindowSize()` is called after a take-over resize
- **THEN** the source sets `window-size` back to the recorded prior value and clears the record;
  a never-resized source's restore is a no-op (no tmux invocation)

#### Scenario: Close detaches pipe and cleans up

- **WHEN** `close()` is called
- **THEN** it invokes `tmux pipe-pane -t <target>` (no command) to detach, kills the local
  reader child, and removes the temp FIFO directory

### Requirement: Real-Tmux Attach Round-Trip

A `hasTmux`-gated integration test SHALL exercise `TmuxPtySource` against a real tmux pane
running a deterministic TUI surrogate (NOT the real Claude TUI), validating the full attach
lifecycle end-to-end.

#### Scenario: Surrogate is deterministic

- **WHEN** the TUI-surrogate fixture runs in a tmux pane
- **THEN** its rendered output is fully controlled (bash/ANSI via `tput`/`printf`), so
  byte-level assertions are stable across runs

#### Scenario: Geometry reflects the real pane

- **WHEN** a `TmuxPtySource` attaches to the surrogate pane sized to a known geometry
- **THEN** `geometry()` returns the pane's actual `<cols>x<rows>` (not the 80x24 default)

#### Scenario: Scrollback captures real pane content byte-exact

- **WHEN** the surrogate prints a known marker line and a source attaches
- **THEN** the seeded scrollback contains that marker line exactly

#### Scenario: Raw input does not auto-submit

- **WHEN** raw bytes without a carriage return are written to the pane
- **THEN** the surrogate shows the typed characters but registers no line submission

#### Scenario: Carriage return submits

- **WHEN** a `0x0D` carriage return is written after input
- **THEN** the surrogate registers exactly one line submission

#### Scenario: Resize drives a new geometry

- **WHEN** `resize(cols, rows)` targets a new size
- **THEN** a subsequent `geometry()` reflects the new dimensions and the surrogate reflows to them

#### Scenario: Teardown restores and cleans up

- **WHEN** the pane is killed (or the source is closed)
- **THEN** the output stream completes, the temp FIFO directory is removed, and any forced
  `window-size manual` is reverted to its prior value

### Requirement: Interact writer reclaim by most recent client

The agent SHALL grant the interactive-input writer to the most recently opened client, evicting any
prior holder (symmetric last-open-wins). When a client opens the interact WebSocket for a session
whose writer mutex is already held by a different live socket, the agent SHALL close the prior
holder with code `4009` — which the macOS dashboard and web terminal already handle by flipping to
their read-only state — and SHALL grant the writer to the new socket. The new opener SHALL NOT be
closed `4009` for contention.

Input ownership is therefore symmetric: a later attach from any device, iOS or macOS, reclaims the
writer for the same session, and the previously-typing device goes read-only. No new client UI is
required; the bumped device surfaces the takeover through its existing read-only badge.

#### Scenario: iOS reclaims the writer from macOS
- **GIVEN** the macOS dashboard holds the interact writer for a session
- **WHEN** the iOS client opens the interact WebSocket for the same session
- **THEN** the agent closes the macOS socket with `4009`, grants the writer to iOS, and the iOS keystrokes reach the PTY
- **AND** the macOS viewer flips to its existing read-only badge

#### Scenario: macOS reclaims the writer back from iOS
- **GIVEN** iOS holds the interact writer after a reclaim
- **WHEN** the macOS dashboard re-opens the interact WebSocket for the same session
- **THEN** the writer is granted back to macOS and the iOS viewer goes read-only

#### Scenario: New opener is never self-denied
- **WHEN** any client opens the interact WebSocket
- **THEN** it is granted the writer, evicting any prior holder, and is never closed `4009` for contention

### Requirement: Interact writer release on session dismissal

When the iOS session screen is dismissed (popped from the navigation stack), the client SHALL close
its interact WebSocket so the writer mutex is released and a stale socket cannot hold the writer
against the next attach. The client SHALL open the interact channel after the session output stream
is established so the writer claim does not race an unregistered stream.

#### Scenario: Writer released on pop
- **WHEN** the user pops the session screen off the navigation stack
- **THEN** the interact WebSocket is closed and the agent releases the writer mutex

#### Scenario: Evicted client flips read-only without a hang
- **WHEN** a client's interact socket is closed `4009` by an eviction
- **THEN** that client flips to read-only and does not silently drop keystrokes while appearing writable

