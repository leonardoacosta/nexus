## 1. PTY Orphan Fix (P1)
- [ ] 1.1 In the `close` handler in `apps/agent/src/server.ts:412-428`, after calling `streamManager.removeViewer(ws)`, add: `if (streamManager.viewerCount(ws.data.sessionId) === 0) { streamManager.endSession(ws.data.sessionId); }`
- [ ] 1.2 Add a unit test that connects two viewers, disconnects one, asserts session is still live, disconnects the second, asserts `endSession` was called and PTY is torn down

## 2. isWriter Enforcement (P2)
- [ ] 2.1 In the `message` handler (`apps/agent/src/server.ts:364-410`), after the `mode !== "interact"` guard, add: `if (!streamManager.isWriter(ws)) { ws.sendText(JSON.stringify({ type: "error", message: "not the interactive writer" })); return; }`
- [ ] 2.2 Add unit tests: (a) non-writer sending input is rejected with error frame; (b) claimed writer sending input is forwarded to PTY

## 3. Reconnect / Resume (P2)
- [ ] 3.1 Add `lastOutput` ring buffer (1000 lines) to `StreamManager` separate from the PTY scrollback — captures output emitted to viewers in real time, not just PTY internal scrollback
- [ ] 3.2 On connect, if client sends `{ type: "reconnect", sessionId }` as the first message, replay the `lastOutput` buffer from after the last line the client acknowledged (or full buffer if no ack)
- [ ] 3.3 Document the reconnect protocol in `design.md` wire format section
- [ ] 3.4 Add integration test: viewer connects, receives N lines, disconnects, N+5 more lines emitted, viewer reconnects with reconnect frame, receives only the 5 missed lines

## 4. Concrete PtySource (NodePtySource) (P3)
- [ ] 4.1 Add `node-pty` to `apps/agent` dependencies (`package.json`)
- [ ] 4.2 Implement `NodePtySource` class in `apps/agent/src/terminal/pty-source.ts` implementing the `PtySource` interface — spawns a PTY via `node-pty`, subscribes to `data` events, writes to stdin, handles resize, closes on `close()`
- [ ] 4.3 Integrate `NodePtySource` into the session attach flow in `server.ts` (replace the `MockPtySource` used for production attach)
- [ ] 4.4 Add smoke test: start `NodePtySource` with `/bin/echo hello`, assert output contains `hello`, assert `close()` terminates the process without leak

## 5. Test State Isolation (P3)
- [ ] 5.1 Extract module-level state (`allSockets`, `pongDeadlines`, `streamManager`) from `server.ts` into a `createServer()` factory function; export the factory
- [ ] 5.2 Update all test files that import from `server.ts` to use the factory — each test suite calls `createServer()` in `beforeEach`
- [ ] 5.3 Verify no test-to-test bleed: run the full test suite twice in sequence and confirm results are identical

## 6. Stale Acceptance Test Fix (P3)
- [ ] 6.1 In `apps/agent/__tests__/acceptance/api-contracts.test.ts:104-117`, update both WebSocket endpoint tests to expect `401` (Unauthorized) instead of `404`
- [ ] 6.2 Update test descriptions to reflect the auth-before-session-check behavior

## 7. Scrollback Join Fix (P3)
- [ ] 7.1 In `StreamManager.addViewer()` (`apps/agent/src/terminal/stream-manager.ts:79-83`), replace `scrollback.join("\n") + "\n"` with a `Uint8Array` concat of the raw buffered bytes — eliminates double newlines when lines already contain `\n`
- [ ] 7.2 Add unit test: emit a line that ends with `\n`, call `addViewer`, assert scrollback replay does not produce `\n\n`

## 8. Session ID Regex (P3)
- [ ] 8.1 Update `SESSION_ID_RE` in `apps/agent/src/server.ts:43` from `/^[a-zA-Z0-9_-]+$/` to `/^[a-zA-Z0-9_.-]+$/`
- [ ] 8.2 Add test cases: `session.abc` returns valid, `session/bad` returns 400
