# Change: Fix PTY lifecycle — orphan cleanup, writer enforcement, reconnect, and concrete PtySource

## Why

The terminal attach subsystem has a P1 correctness bug: when a WebSocket viewer disconnects
normally, the PTY session is never torn down. Only the pong-timeout path calls `endSession()`;
the `close` handler calls `removeViewer()` but never checks `viewerCount === 0`. This means
PTY processes leak on every normal disconnect. Additionally, `isWriter()` is defined but never
called in the interact message handler, leaving write access ungated; there is no reconnect/resume
support so viewers lose all output emitted during a connection gap; and there is no concrete
`PtySource` implementation — only `MockPtySource` exists, making production terminal attach
non-functional.

## What Changes

- **BREAKING (test fixtures):** Export a `createServer()` factory from `server.ts` so tests
  create fresh state (allSockets, pongDeadlines, streamManager) per test instead of sharing
  module-level globals — eliminates test interference.
- Fix PTY orphan on normal disconnect: add `viewerCount === 0` guard to the `close` handler
  identical to the pong-timeout path (`apps/agent/src/server.ts:412-428`).
- Enforce write access: call `isWriter(ws)` before processing any input (text or binary) in
  the `interact` message handler (`apps/agent/src/server.ts:364-410`).
- Add reconnect/resume: session ID used as reconnect key; scrollback buffer capped at 1000
  lines for replay; client sends `{ type: "reconnect", sessionId }` control frame on connect
  to receive buffered output from the gap (`apps/agent/src/terminal/stream-manager.ts:67-86`).
- Implement `NodePtySource` — a concrete `PtySource` backed by `node-pty`; `MockPtySource`
  remains for tests (`apps/agent/src/terminal/pty-source.ts:53-145`).
- Fix scrollback join: use `Buffer` concatenation instead of `\n` string join to avoid double
  newlines when input lines already contain newlines (`apps/agent/src/terminal/stream-manager.ts:79-83`).
- Relax session ID regex: allow dots — update `SESSION_ID_RE` to `/^[a-zA-Z0-9_.-]+$/` to
  avoid rejecting valid Claude Code session IDs (`apps/agent/src/server.ts:43`).
- Update stale acceptance tests: expect `401` (not `404`) on unauthenticated WebSocket requests
  (`apps/agent/__tests__/acceptance/api-contracts.test.ts:104-117`).

## Impact

- Affected specs: `terminal-attach` (new capability spec)
- Affected code:
  - `apps/agent/src/server.ts` — close handler, interact handler, session ID regex, server factory
  - `apps/agent/src/terminal/stream-manager.ts` — reconnect support, scrollback join fix
  - `apps/agent/src/terminal/pty-source.ts` — NodePtySource implementation
  - `apps/agent/__tests__/acceptance/api-contracts.test.ts` — stale 404 → 401 expectations
  - `apps/agent/__tests__/` (all test files using module-level state) — migrate to factory
