# Design: PTY adaptive geometry + true fullscreen

## Context

The PTY stream is a WebSocket (`/sessions/{id}/stream`) carrying raw pane bytes;
the Swift side consumes it via `NWConnection` (`NexusClient` § "PTY WebSocket
bridge"). Input is forwarded out-of-band over HTTP `POST /commands/send-text`.
There is no existing channel for geometry or resize.

## Decisions

### D1 — Geometry transport: interleaved JSON control frame on the stream WS

The agent already owns the stream WebSocket and sends binary byte bursts. Add a
**text** control frame distinguishable from the binary PTY bytes:

```json
{ "type": "geometry", "cols": 120, "rows": 40 }
```

- Binary frames remain raw PTY bytes (unchanged — fed straight to SwiftTerm).
- Text frames are parsed as JSON control messages; `geometry` updates the
  viewer's target grid.

Rationale: reuses the live stream connection (no new endpoint, no second socket),
and WebSocket already distinguishes text vs binary opcodes so the demux is free.
The Swift `consumePtyStream` handler currently treats every message as bytes; it
gains a branch on opcode/text.

Alternative rejected: a separate `GET /sessions/{id}/geometry` poll — adds a
request path and a staleness window, and can't push source-resize updates.

### D2 — Source geometry acquisition (agent)

- **tmux source:** `tmux display-message -p -t <target> '#{pane_width}x#{pane_height}'`
  read once at attach, then re-read when the agent observes a resize. Minimal
  approach: emit geometry at attach + on each viewer-driven resize ack. Source-
  initiated resize detection (a real user resizing) can poll pane size on a low
  cadence or hook `tmux`'s `client-resized`; the simplest first cut polls on the
  same pipe-pane read loop and emits a geometry frame when the value changes.
- **node-pty source:** report the constructed `cols`/`rows` directly.

### D3 — Resize command transport: HTTP `POST /commands/resize`

Mirror the existing `send-text` command shape rather than overloading the stream
socket (resize is a control action, not stream data, and the send-text precedent
keeps client code uniform):

```
POST /commands/resize  { "sessionId": "...", "cols": 200, "rows": 50 }
```

- Managed-gate is enforced server-side (authoritative) AND client-side (the
  toggle is hidden for non-managed). Server-side rejection returns a non-2xx the
  client logs.
- On first resize for a session, the agent records original geometry in the
  stream/session state (in-memory, keyed by sessionId) before applying.

### D4 — tmux resize mechanism + auto-restore

- Apply: `tmux resize-window -t <target> -x <cols> -y <rows>` (window-level; pane
  follows for single-pane Claude sessions). If the session uses
  `window-size latest/largest`, the agent sets `window-size manual` for the
  duration of take-over so the requested size sticks, restoring the prior
  `window-size` option on detach.
- Restore: on last take-over viewer disconnect, resize back to the recorded
  original geometry and clear the record. Hook into the existing
  `removeViewer`/`endSession` path in `server-websocket.ts` so restore fires on
  both normal close and pong-timeout (parity with the existing PTY lifecycle
  teardown requirement).

### D5 — SwiftTerm grid lock vs take-over

- `PtyViewerModel` gains a `geometryMode` (`.lock` default / `.takeOver`) and a
  `reportedGeometry: (cols, rows)?`.
- Lock mode: on each `geometry` frame, set the SwiftTerm grid to the reported
  size. The representable constrains/letterboxes rather than stretching.
- Take-over mode: `PtyTerminalCoordinator.sizeChanged(newCols, newRows)` — today a
  no-op — forwards to `model.requestResize(cols, rows)` → `POST /commands/resize`.
  On toggle-off / `onDisappear`, revert to lock and let the agent auto-restore.

### D6 — Robust fullscreen (WindowAccessor)

`WindowAccessor` currently resolves the window in one `DispatchQueue.main.async`
and no-ops if `view.window` is nil; `updateNSView` is empty. Fix:

- Move the `onWindow` application into a small helper that retries on the next
  runloop tick (bounded retries) until `view.window` is non-nil.
- Also call the helper from `updateNSView` so any later attach re-applies. The
  `collectionBehavior.insert(.fullScreenPrimary)` is idempotent, so repeated
  application is safe.

## Risks

- **Source-resize detection cost:** polling pane size on the pipe loop is cheap
  but not instantaneous; acceptable for the first cut (geometry frames are small
  and idempotent on the client).
- **window-size option churn:** toggling `window-size manual` during take-over
  must restore the original option on detach to avoid surprising the real user;
  covered by the auto-restore path.
- **NexusClient.swift overlap with `airpods-stt-command`:** different sections;
  wave planner serializes. No logical coupling.
