## Context

The Nexus agent exposes WebSocket endpoints (`/sessions/{id}/stream` and
`/sessions/{id}/interact`) for terminal attach. The `StreamManager` class manages the per-session
fan-out of PTY output to connected viewers and tracks the interactive writer mutex.

The platform audit (2026-04-06) identified a P1 correctness bug (PTY orphan on normal disconnect),
two P2 defense gaps (ungated write access, no reconnect), and several P3 hygiene issues. This
design covers the state machine, reconnect wire protocol, `PtySource` interface, and test isolation
strategy. All changes are within the existing Bun HTTP/WebSocket server — no new infrastructure.

## Goals / Non-Goals

- Goals:
  - Eliminate PTY process leaks on normal WebSocket disconnect
  - Enforce `isWriter` check before forwarding any input to the PTY
  - Enable viewers to resume after a connection gap without losing output
  - Provide a concrete `NodePtySource` so production terminal attach is functional
  - Isolate test state so tests do not interfere with one another
  - Fix stale test expectations and minor format bugs (scrollback join, session ID regex)

- Non-Goals:
  - Session recording / persistent audit trail (GCF — tracked separately)
  - Multi-viewer write coordination / turn-based access (GCF — tracked separately)
  - Horizontal scaling or distributed PTY fan-out

## Decisions

### PTY Lifecycle State Machine

```
                          first addViewer
  [detached] ──attach()──────────────────► [active]
                                               │
                                 close(ws) OR pong-timeout(ws)
                                               │
                                   removeViewer(ws)
                                               │
                                  viewerCount === 0?
                                     ┌────┴─────┐
                                    YES          NO
                                     │           │
                               endSession()   [active]
                                     │
                              [terminated]
```

**Decision**: Mirror the pong-timeout path exactly in the `close` handler. Both paths call
`removeViewer(ws)` then check `viewerCount === 0` before calling `endSession()`. No new
abstraction — a one-line guard added to the existing `close` handler.

**Alternative considered**: Move the `viewerCount` check into `removeViewer()` itself, making
it auto-teardown when empty. Rejected — it couples `StreamManager` to session lifecycle policy;
the caller (server.ts) should decide when to end a session.

### isWriter Enforcement

The interact message handler (`server.ts:364-410`) currently has a `mode !== "interact"` guard
but does not call `isWriter(ws)`. Any interact-mode client — whether or not it has claimed the
write mutex via `claimWriter()` — can send keystrokes to the PTY.

**Decision**: Add `if (!streamManager.isWriter(ws)) { ... return; }` immediately after the
mode guard. The check is cheap (Map lookup + reference comparison). Clients that attempt to
write without claiming the mutex receive `{ type: "error", message: "not the interactive writer" }`.

### Reconnect Protocol

**Wire format** (client → server, JSON text frame on connect):
```json
{ "type": "reconnect", "sessionId": "<id>" }
```

Sent as the first message after the WebSocket handshake. The server responds by replaying
buffered output emitted since the session started (or since session creation, bounded by the
ring buffer size).

**Buffer strategy**: `StreamManager` maintains a second `RingBuffer` named `lastOutput` (1000
lines, distinct from the PTY-internal scrollback). Every chunk emitted via `onData` is appended
to `lastOutput` after being forwarded to current viewers. On a reconnect frame, the entire
`lastOutput` buffer is sent as a binary replay burst followed by a `{ type: "replay_done" }`
sentinel frame.

**Capacity**: 1000 lines ≈ ~80 KB at 80 chars/line — negligible per session. No persistence;
buffer is in-memory and lost if the agent restarts.

**Session ID as reconnect key**: The session ID already uniquely identifies a session in
`StreamManager`. No additional token is needed for reconnect within the same agent process.

**Alternative considered**: Storing byte offsets and having the client send `{ "after": N }`.
Rejected for v1 — adds protocol complexity without strong benefit since the buffer is small and
replaying the full buffer is safe (terminal emulator handles idempotent state).

### NodePtySource Implementation

The `PtySource` interface is already correct. The concrete implementation wraps `node-pty`:

```typescript
import * as pty from "node-pty";

export class NodePtySource implements PtySource {
  private term: pty.IPty;
  private scrollback: RingBuffer;
  private listeners = new Set<(data: Uint8Array) => void>();

  constructor(shell: string, args: string[], opts: { cols: number; rows: number; cwd: string }) {
    this.scrollback = new RingBuffer(DEFAULT_SCROLLBACK_CAPACITY);
    this.term = pty.spawn(shell, args, { ...opts, encoding: null }); // binary mode
    this.term.onData((data: string | Uint8Array) => {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const line of new TextDecoder().decode(bytes).split("\n")) {
        if (line.length > 0) this.scrollback.push(line);
      }
      for (const cb of this.listeners) {
        try { cb(bytes); } catch { /* ignore */ }
      }
    });
  }

  onData(cb: (data: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getScrollback(): string[] { return this.scrollback.toArray(); }
  write(data: Uint8Array): void { this.term.write(data as unknown as string); }
  resize(cols: number, rows: number): void { this.term.resize(cols, rows); }
  close(): void { try { this.term.kill(); } catch { /* already dead */ } this.listeners.clear(); }
}
```

`MockPtySource` remains unchanged and is the default for tests.

### Test State Isolation

Module-level state (`allSockets`, `pongDeadlines`, `streamManager`) is currently initialized
once at import time. Tests share this state unless they manually reset it — fragile and order-dependent.

**Decision**: Extract state into a `createServer()` factory:

```typescript
export function createServer(opts?: { port?: number }) {
  const allSockets = new Set<ServerWebSocket<WsData>>();
  const pongDeadlines = new Map<...>();
  const streamManager = new StreamManager();
  // ... build Bun.serve(...) with these instances
  return { server, streamManager };
}
```

The module-level export remains for production use. Tests call `createServer()` in `beforeEach`
and `server.stop()` in `afterEach`.

**Alternative considered**: `beforeEach` reset helpers that reach into module internals (e.g.,
`allSockets.clear()`). Rejected — brittle, requires exporting private state.

### Scrollback Join Fix

Current code: `scrollback.join("\n") + "\n"` — if any scrollback line already ends with `\n`,
the join produces `\n\n`. Terminal emulators render this as a blank line per occurrence.

**Decision**: Replace the string join with direct `Uint8Array` concatenation of the raw bytes
stored in the PTY source's internal buffer. The `PtySource.getScrollback()` API returns `string[]`
(already split by `\n` with trailing newlines stripped by the `split` in `MockPtySource.emit`).
The join fix: use `scrollback.map(l => l + "\n").join("")` — each line gets exactly one newline,
no trailing blank line.

### Session ID Regex

Current: `/^[a-zA-Z0-9_-]+$/` — rejects dots. Claude Code generates session IDs that include
dots (e.g., `session.2026-04-06.1`). Updated to `/^[a-zA-Z0-9_.-]+$/`.

The `.` in a character class is literal, not a wildcard — no security regression. Path traversal
is already prevented by the WebSocket route regex anchoring on `/sessions/<id>/stream`.

## Risks / Trade-offs

- **NodePtySource process leak on crash**: if the agent panics after spawning a PTY, the child
  process may outlive the agent. Mitigation: `close()` calls `term.kill()`; agent shutdown hook
  calls `streamManager.shutdown()` which calls `endSession()` on all sessions.
- **Reconnect replay burst**: replaying 1000 lines on reconnect could saturate the WebSocket
  send buffer for slow clients. Existing 1 MB buffer-overflow guard in `StreamManager.attach()`
  already handles this — slow clients are disconnected.
- **node-pty native module**: adds a native binding dependency. Must be compiled for the target
  platform. CI must install build tools (`python`, `make`, `node-gyp`) if not already present.

## Migration Plan

1. Apply tasks 1 (PTY fix) and 2 (isWriter) first — no API changes, safe to ship immediately.
2. Apply task 6 (stale test fix) alongside task 1 — tests will fail until auth-before-PTY-check
   order is confirmed correct.
3. Apply task 8 (session ID regex) independently — single-line change, zero risk.
4. Apply task 7 (scrollback join) independently — output format fix only.
5. Apply task 5 (test isolation) before tasks 3 and 4 — factory must exist before reconnect and
   NodePtySource tests are written.
6. Apply tasks 3 (reconnect) and 4 (NodePtySource) last — these are the highest-complexity items.

## Open Questions

- Should `NodePtySource` spawn a shell (e.g., `/bin/bash`) or attach to an existing tmux session
  for Claude Code? The audit notes "SSH + tmux" as the attach mechanism — confirm with Leo before
  implementing task 4.3 (integration into session attach flow).
- Should the reconnect buffer be configurable per agent via `agents.toml`, or is 1000 lines
  always sufficient?
