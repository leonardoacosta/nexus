# web-dashboard Specification

## Purpose
TBD - created by archiving change wterm-web-terminal. Update Purpose after archive.
## Requirements
### Requirement: Next.js Web App Scaffold
The system SHALL provide a Next.js (App Router) application at `apps/web`, registered in the
pnpm/turbo workspace. The dev server SHALL be bindable to the Tailscale interface and SHALL read the
target agent base URL from `NEXT_PUBLIC_NEXUS_AGENT_URL`. When that variable is unset, the app SHALL
render a clear configuration-required message rather than crashing.

#### Scenario: App builds and runs in the workspace
- **WHEN** `pnpm --filter @nexus/web dev` is run
- **THEN** the Next.js dev server starts and serves the attach route

#### Scenario: Missing agent URL is surfaced
- **WHEN** `NEXT_PUBLIC_NEXUS_AGENT_URL` is unset and the attach page loads
- **THEN** the page renders a "configure agent URL" message and does not throw

### Requirement: Browser Agent WebSocket Client
The system SHALL provide a browser TypeScript client that connects to the agent's
`GET /sessions/:id/stream` and `GET /sessions/:id/interact` endpoints. The client SHALL rewrite
`http`->`ws` and `https`->`wss` when deriving the socket URL. The client SHALL demultiplex inbound
frames: binary frames are raw PTY output, text frames are JSON control frames (`{"type":"geometry",...}`,
`{"type":"replay_done"}`). The client SHALL request scrollback replay on reconnect via
`{"type":"reconnect","sessionId":...}` and SHALL handle the read-only writer-mutex close (code 4009)
without throwing.

#### Scenario: Scheme rewrite
- **WHEN** the agent base URL is `http://100.x:7400`
- **THEN** the stream socket connects to `ws://100.x:7400/sessions/:id/stream`

#### Scenario: Frame demultiplexing
- **WHEN** the client receives a binary frame followed by a text `{"type":"geometry","cols":80,"rows":24}` frame
- **THEN** the binary bytes are routed to the renderer feed and the geometry frame resizes the grid

#### Scenario: Replay on reconnect
- **WHEN** the socket reconnects after a drop
- **THEN** the client sends `{"type":"reconnect","sessionId":...}` and renders the replayed buffer
  before resuming the live stream

#### Scenario: Read-only close handled
- **WHEN** the interact socket closes with code 4009 (another viewer holds the writer mutex)
- **THEN** the client marks the session read-only and disables input without surfacing an error dialog

### Requirement: wterm Ghostty Renderer Integration
The attach view SHALL render terminal output using `@wterm/ghostty` (libghostty WASM) as the VT core
and `@wterm/dom` as the renderer. Inbound stream `.bytes` SHALL be fed via `core.writeRaw(Uint8Array)`,
and inbound `geometry` frames SHALL drive `core.resize(cols, rows)`. The WASM module SHALL be served
by the Next.js app and loaded via `fetch` + `WebAssembly.instantiate` — it SHALL NOT require
SharedArrayBuffer or COOP/COEP cross-origin-isolation headers.

#### Scenario: Bytes render
- **WHEN** the stream delivers PTY bytes for a session
- **THEN** `core.writeRaw` is called with those bytes and the corresponding glyphs render in the DOM

#### Scenario: Geometry drives grid size
- **WHEN** a `{"type":"geometry","cols":120,"rows":40}` frame arrives
- **THEN** the terminal grid is resized to 120x40 before subsequent bytes are fed

#### Scenario: WASM loads without isolation headers
- **WHEN** the attach page loads the `ghostty-vt.wasm` asset
- **THEN** it loads via `fetch` + `instantiate` and renders without COOP/COEP response headers set

### Requirement: Interactive Input and Resize
The attach view SHALL be fully interactive when the session is writable: keystrokes surfaced by
`@wterm/dom` `onData` SHALL be sent as stdin over the `/interact` socket, and view size changes
reported by the `ResizeObserver` `onResize` SHALL be sent as `{"type":"resize","cols":N,"rows":N}`.
When the session is read-only (writer mutex held elsewhere, code 4009), input and resize emission
SHALL be suppressed.

#### Scenario: Keystroke round-trips
- **WHEN** the user types in a writable attached session
- **THEN** the keystroke bytes are sent over `/interact` and the echoed output renders back

#### Scenario: User resize emits resize frame
- **WHEN** the terminal element is resized and `onResize(100, 30)` fires on a writable session
- **THEN** the client sends `{"type":"resize","cols":100,"rows":30}` to the agent

#### Scenario: Input suppressed when read-only
- **WHEN** the session is read-only
- **THEN** typed keystrokes are not sent and no resize frame is emitted

### Requirement: Renderer Throughput Gate
Before the web terminal is considered shippable, the system SHALL measure `@wterm/dom`
renderer throughput under high-volume PTY output (e.g. a busy `yes` / large `cat` stream) and record
whether it sustains rendering within an acceptable frame budget. If the budget is not met, the
fallback (xterm.js, at the cost of iOS VT-engine parity) SHALL be flagged for a decision; the gate
SHALL NOT be silently passed.

#### Scenario: Throughput measured and recorded
- **WHEN** a high-volume output stream is fed through `core.writeRaw` in the attach view
- **THEN** frame timing is measured and a pass/fail verdict against the budget is recorded

#### Scenario: Failing budget surfaces the fallback decision
- **WHEN** the measured throughput misses the frame budget
- **THEN** the result is reported with the xterm.js fallback trade-off, not marked complete

### Requirement: Session List and Creation
The web app SHALL provide a home view that lists active sessions from the agent's `GET /sessions`,
each linking to its `/attach/:session` route, and SHALL provide an action to start a new session via
`POST /session/start`. Because sessions persist server-side (tmux + agent DB), the list SHALL reflect
the same active sessions across browser reloads — closing and reopening the page SHALL show the
sessions that are still running.

#### Scenario: Active sessions listed with attach links
- **WHEN** the home view loads and the agent reports active sessions on `GET /sessions`
- **THEN** each active session is rendered with a link to its `/attach/:session` route

#### Scenario: Sessions persist across page close and reopen
- **WHEN** a session is active, the browser page is closed, and the home view is reopened
- **THEN** that session still appears in the list and is attachable

#### Scenario: Start a new session from the web
- **WHEN** the user triggers "new session" with a project and path
- **THEN** the app calls `POST /session/start` and the newly created session appears in the list and
  is attachable

